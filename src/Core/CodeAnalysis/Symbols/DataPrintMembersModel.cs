// <copyright file="DataPrintMembersModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0199: the single decision point for the C#-record <c>PrintMembers(StringBuilder)</c>
/// slot of a <c>data class</c> / <c>data struct</c> — whether the type has
/// one, which accessibility and virtuality it carries, which base slot it
/// overrides, and which members it prints. Binding, member lookup and the
/// emitter all read the answer from here.
/// </summary>
internal static class DataPrintMembersModel
{
    /// <summary>The name of the print-members slot.</summary>
    internal const string Name = "PrintMembers";

    /// <summary>Gets a value indicating whether <paramref name="type"/> is a G# data type declared in source (a native <c>data</c> declaration, not an anonymous literal).</summary>
    /// <param name="type">The type to test.</param>
    /// <returns><see langword="true"/> when the type is a declared source data type.</returns>
    internal static bool IsDeclaredDataType(StructSymbol type)
        => type.IsData && type.ClrType == null && !type.IsAnonymousLiteral;

    /// <summary>
    /// Gets the user-declared <c>PrintMembers(StringBuilder)</c> slot, when
    /// the type declares one (ADR-0199: it replaces the synthesized member).
    /// </summary>
    /// <param name="type">The data type.</param>
    /// <returns>The declared method, or null.</returns>
    internal static FunctionSymbol? FindDeclared(StructSymbol type)
    {
        if (type.Methods.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var method in type.Methods)
        {
            if (IsSlotName(method.Name, method.Parameters))
            {
                return method;
            }
        }

        return null;
    }

    /// <summary>
    /// Tests whether a method name and parameter list denote the print-members
    /// slot: <c>PrintMembers</c> taking exactly one <see cref="StringBuilder"/>.
    /// Other overloads named <c>PrintMembers</c> are ordinary methods.
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <param name="parameters">The parameters.</param>
    /// <returns><see langword="true"/> when the shape names the slot.</returns>
    internal static bool IsSlotName(string name, ImmutableArray<ParameterSymbol> parameters)
        => name == Name
            && !parameters.IsDefaultOrEmpty
            && parameters.Length == 1
            && parameters[0].RefKind == RefKind.None
            && IsStringBuilder(parameters[0].Type);

    /// <summary>Tests whether a type is <see cref="StringBuilder"/> (ignoring reference nullability).</summary>
    /// <param name="type">The type.</param>
    /// <returns><see langword="true"/> for <c>StringBuilder</c>.</returns>
    internal static bool IsStringBuilder(TypeSymbol type)
        => type.ClrType is { } clr && ClrTypeUtilities.AreSame(clr, typeof(StringBuilder));

    /// <summary>Resolves the base slot this type's print-members overrides.</summary>
    /// <param name="owner">The data type.</param>
    /// <param name="importedMethod">The actual imported slot, when the base is a native record.</param>
    /// <returns>The symbolic base owner, or null when the type starts its own slot.</returns>
    internal static TypeSymbol? GetBase(StructSymbol owner, out MethodInfo? importedMethod)
    {
        importedMethod = null;
        if (!owner.IsData || !owner.IsClass)
        {
            return null;
        }

        var hierarchy = owner.GetHierarchy();
        for (var level = 0; level < hierarchy.Count; level++)
        {
            var ancestor = hierarchy[level];
            if (level > 0 && IsDeclaredDataType(ancestor))
            {
                return ancestor;
            }

            if (ancestor.ImportedBaseType is not { ClrType: { } clrBase } importedBase)
            {
                continue;
            }

            foreach (var method in ClrTypeUtilities.SafeGetMethods(
                         clrBase, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                var parameters = method.GetParameters();
                if (method.Name == Name
                    && method.IsVirtual && !method.IsFinal && !method.IsGenericMethod
                    && (method.IsFamily || method.IsFamilyOrAssembly)
                    && ClrTypeUtilities.AreSame(method.ReturnType, typeof(bool))
                    && parameters.Length == 1
                    && ClrTypeUtilities.AreSame(parameters[0].ParameterType, typeof(StringBuilder)))
                {
                    importedMethod = method;
                    return importedBase;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Gets the accessibility the slot must have: <c>private</c> for a sealed
    /// type that starts the slot, <c>protected</c> otherwise (Roslyn's model).
    /// </summary>
    /// <param name="owner">The data type.</param>
    /// <returns>The required accessibility.</returns>
    internal static Accessibility GetRequiredAccessibility(StructSymbol owner)
        => IsSealed(owner) && GetBase(owner, out _) is null ? Accessibility.Private : Accessibility.Protected;

    /// <summary>Tests whether no type can derive from <paramref name="owner"/>.</summary>
    /// <param name="owner">The data type.</param>
    /// <returns><see langword="true"/> for a struct or a non-extensible class.</returns>
    internal static bool IsSealed(StructSymbol owner)
        => !owner.IsClass || (!owner.IsOpen && !owner.IsSealedHierarchy);

    /// <summary>Creates the compiler-owned print-members slot for a data type that does not declare one.</summary>
    /// <param name="owner">The data type.</param>
    /// <returns>The synthesized slot, or null for a type that gets none (an anonymous literal).</returns>
    internal static FunctionSymbol? Create(StructSymbol owner)
    {
        if (!IsDeclaredDataType(owner))
        {
            return null;
        }

        var hasBase = GetBase(owner, out _) is not null;
        var builder = ImportedTypeSymbol.GetWithoutNullability(typeof(StringBuilder), NullabilityFreeReason.CompilerProduced);
        return new FunctionSymbol(
            Name,
            ImmutableArray.Create(new ParameterSymbol("builder", builder)),
            TypeSymbol.Bool,
            declaration: null,
            package: null,
            accessibility: GetRequiredAccessibility(owner),
            receiverType: owner,
            isOpen: !IsSealed(owner) && !hasBase,
            isOverride: hasBase);
    }

    /// <summary>
    /// Gets the members <c>PrintMembers</c> prints, in declaration order: the
    /// public instance fields and the public readable non-indexer, non-override properties
    /// the type itself declares (Roslyn's rule). Private members still take
    /// part in equality, but never in the text.
    /// </summary>
    /// <param name="owner">The data type.</param>
    /// <returns>The printable members.</returns>
    internal static ImmutableArray<PrintableMember> GetPrintableMembers(StructSymbol owner)
    {
        var members = ImmutableArray.CreateBuilder<(int Position, int Group, PrintableMember Member)>();
        foreach (var field in owner.Fields)
        {
            if (field.IsStatic
                || field.Accessibility != Accessibility.Public
                || field.Type is PointerTypeSymbol)
            {
                continue;
            }

            members.Add((field.Declaration?.Span.Start ?? -1, 0, new PrintableMember(field.Name, field, null)));
        }

        foreach (var property in owner.Properties)
        {
            // Roslyn skips an override: the base declaration already prints it
            // (through the virtual getter), so printing both would repeat it.
            if (property.IsStatic
                || property.IsOverride
                || property.IsIndexer
                || !property.HasGetter
                || property.Accessibility != Accessibility.Public
                || property.ReturnRefKind != RefKind.None
                || property.Type is PointerTypeSymbol)
            {
                continue;
            }

            members.Add((property.Declaration?.Span.Start ?? -1, 1, new PrintableMember(property.Name, null, property)));
        }

        // Stable: positional parameters (no body position) first, then source
        // order, with a field before a property at an equal position.
        return members
            .Select((entry, index) => (entry.Position, entry.Group, Index: index, entry.Member))
            .OrderBy(entry => entry.Position)
            .ThenBy(entry => entry.Group)
            .ThenBy(entry => entry.Index)
            .Select(entry => entry.Member)
            .ToImmutableArray();
    }

    /// <summary>A member printed by <c>PrintMembers</c>.</summary>
    /// <param name="Name">The printed name.</param>
    /// <param name="Field">The field, for a field member.</param>
    /// <param name="Property">The property, for a property member.</param>
    internal readonly record struct PrintableMember(string Name, FieldSymbol? Field, PropertySymbol? Property)
    {
        /// <summary>Gets the member's type.</summary>
        internal TypeSymbol Type => Field?.Type ?? Property!.Type; // Exactly one of Field/Property is set by GetPrintableMembers.
    }
}
