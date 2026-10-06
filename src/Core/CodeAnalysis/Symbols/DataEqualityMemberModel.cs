// <copyright file="DataEqualityMemberModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>Compiler-owned signatures shared by data equality binding and emission.</summary>
internal static class DataEqualityMemberModel
{
    /// <summary>Resolves the immediate source or imported record self-equality slot.</summary>
    /// <param name="owner">The derived data class.</param>
    /// <param name="importedMethod">The actual imported slot, when the base is native.</param>
    /// <returns>The symbolic direct owner, or null when it has no record equality slot.</returns>
    internal static TypeSymbol? GetDirectBase(StructSymbol owner, out MethodInfo? importedMethod)
    {
        importedMethod = null;
        if (!owner.IsData || !owner.IsClass)
        {
            return null;
        }

        if (owner.BaseClass is { IsData: true, ClrType: null } sourceBase)
        {
            var ancestor = hierarchy[level];
            if (level > 0 && ancestor is { IsData: true, ClrType: null })
            {
                if (FindSealedIntermediaryOverride(hierarchy, level, ancestor) != null)
                {
                    return null;
                }

                return ancestor;
            }

            if (GetImportedDataBase(ancestor) is not { } importedDataBase)
            {
                continue;
            }

            var (importedBase, clrBase) = importedDataBase;
            if (FindSealedIntermediaryOverride(hierarchy, level + 1, importedBase) != null)
            {
                return null;
            }

        foreach (var method in ClrTypeUtilities.SafeGetMethods(
                     clrBase, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
        {
            var parameters = method.GetParameters();
            if (method.Name == "Equals"
                && method.IsVirtual && !method.IsFinal && !method.IsGenericMethod
                && ClrTypeUtilities.AreSame(method.ReturnType, typeof(bool))
                && parameters.Length == 1
                && ClrTypeUtilities.AreSame(parameters[0].ParameterType, clrBase))
            {
                importedMethod = method;
                return importedBase;
            }
        }

        return null;
    }

    /// <summary>Finds a sealed source override that blocks the inherited typed equality slot.</summary>
    /// <param name="owner">The derived data class.</param>
    /// <returns>The blocking override, or null when the slot remains overridable.</returns>
    internal static FunctionSymbol? GetSealedIntermediaryOverride(StructSymbol owner)
    {
        if (!owner.IsData || !owner.IsClass)
        {
            return null;
        }

        var hierarchy = owner.GetHierarchy();
        for (var level = 1; level < hierarchy.Count; level++)
        {
            var ancestor = hierarchy[level];
            if (ancestor is { IsData: true, ClrType: null } dataBase)
            {
                return FindSealedIntermediaryOverride(hierarchy, level, dataBase);
            }

            if (GetImportedDataBase(ancestor) is { } importedDataBase)
            {
                return FindSealedIntermediaryOverride(hierarchy, level + 1, importedDataBase.Symbol);
            }
        }

        return null;
    }

    internal static FunctionSymbol? FindSealedIntermediaryOverride(
        IReadOnlyList<StructSymbol> hierarchy,
        int dataBaseLevel,
        TypeSymbol dataBase)
    {
        for (var level = 1; level < dataBaseLevel; level++)
        {
            foreach (var method in hierarchy[level].Methods)
            {
                if (IsSealedIntermediaryEqualityOverride(method, dataBase))
                {
                    return method;
                }
            }
        }

        return null;
    }

    internal static bool IsSealedIntermediaryEqualityOverride(FunctionSymbol method, TypeSymbol dataBase)
        => method.Name == "Equals"
            && method.IsOverride
            && !method.IsOpen
            && method.TypeParameters.IsDefaultOrEmpty
            && method.Type == TypeSymbol.Bool
            && method.ReturnRefKind == RefKind.None
            && method.Parameters.Length == 1
            && method.Parameters[0].RefKind == RefKind.None
            && TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                method.Parameters[0].Type,
                dataBase);

    internal static (TypeSymbol Symbol, Type Clr)? GetImportedDataBase(StructSymbol ancestor)
    {
        if (ancestor.ImportedBaseType is not { ClrType: { } clrBase } importedBase
            || ((!ImportedAssemblySemantics.TryGetTypeSemantics(clrBase, out var semantics)
                 && !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(clrBase, out semantics))
                || !semantics.IsData))
        {
            return null;
        }

        return (importedBase, clrBase);
    }

    /// <summary>Creates a self or inherited typed-base equality member.</summary>
    /// <param name="owner">The declaring data type.</param>
    /// <param name="otherType">The self type or direct data base.</param>
    /// <param name="isOverride">Whether this member overrides the direct base typed slot.</param>
    /// <param name="importedMethod">The actual imported slot supplying its parameter contract.</param>
    /// <returns>The compiler-owned equality signature.</returns>
    internal static FunctionSymbol Create(StructSymbol owner, TypeSymbol otherType, bool isOverride, MethodInfo? importedMethod = null)
    {
        var definition = typeof(IEquatable<>);
        var method = Invariant.Required(definition.GetMethod("Equals"), "IEquatable<T> declares Equals");
        var signatureType = otherType is StructSymbol { IsGenericDefinition: true } sourceType
            ? StructSymbol.Construct(sourceType, sourceType.TypeParameters.Cast<TypeSymbol>().ToImmutableArray())
            : otherType;
        var parameterType = importedMethod is null
            ? MemberLookup.GetClrOpenParameterTypeSymbol(
                method.GetParameters()[0],
                definition,
                ImmutableArray.Create<TypeSymbol>(signatureType))
            : MemberLookup.GetClrMethodParameterTypeSymbol(signatureType, importedMethod, 0);
        var parameterName = importedMethod is null
            ? "other"
            : importedMethod.GetParameters()[0].Name ?? $"arg{importedMethod.GetParameters()[0].Position}";
        return new FunctionSymbol(
            "Equals",
            ImmutableArray.Create(new ParameterSymbol(parameterName, parameterType)),
            TypeSymbol.Bool,
            declaration: null,
            package: null,
            accessibility: Accessibility.Public,
            receiverType: owner,
            isOpen: owner.IsClass && (owner.IsOpen || owner.IsSealedHierarchy) && !isOverride,
            isOverride: isOverride);
    }

    /// <summary>Creates the existing synthesized override of object equality.</summary>
    /// <param name="owner">The declaring data type.</param>
    /// <returns>The compiler-owned object equality signature.</returns>
    internal static FunctionSymbol CreateObject(StructSymbol owner)
    {
        var method = Invariant.Required(
            typeof(object).GetMethod("Equals", new[] { typeof(object) }),
            "System.Object declares instance Equals");
        var parameter = method.GetParameters()[0];
        return new FunctionSymbol(
            "Equals",
            ImmutableArray.Create(new ParameterSymbol(
                Invariant.Required(parameter.Name, "System.Object.Equals has a named parameter"),
                MemberLookup.GetClrOpenParameterTypeSymbol(parameter, typeof(object), ImmutableArray<TypeSymbol>.Empty))),
            TypeSymbol.Bool,
            declaration: null,
            package: null,
            accessibility: Accessibility.Public,
            receiverType: owner,
            isOpen: owner.IsClass && (owner.IsOpen || owner.IsSealedHierarchy),
            isOverride: true);
    }
}
