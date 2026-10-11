// <copyright file="EmitCacheKeyRemapScopeAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// GSA0004 (issue #3163): enforces the Emit cache-key invariant — every
/// dictionary in <c>GSharp.Core.CodeAnalysis.Emit</c> that maps symbols to
/// scope-sensitive metadata rows (TypeSpec / MemberRef / MethodSpec /
/// EntityHandle) must include the generic-remap scope (<c>RemapScope</c>)
/// in its key.
/// </summary>
/// <remarks>
/// <para>
/// The same symbol encodes to different <c>VAR</c>/<c>MVAR</c> ordinals
/// depending on the remaps active on <c>GenericRemapState</c>, so a cache
/// key that omits the scope reuses a row whose signature blob encodes the
/// other scope's ordinals — an invalid assembly discovered only at runtime
/// (<c>BadImageFormatException</c>). This bug class shipped as #2930/#3057
/// (constructor MemberRefs) and again as #3065 (MethodSpecs); this rule
/// makes a third recurrence a build break instead of a runtime defect.
/// </para>
/// <para>
/// Definition-handle caches (<c>TypeDefinitionHandle</c>,
/// <c>MethodDefinitionHandle</c>, <c>FieldDefinitionHandle</c>, ...) are
/// scope-invariant by construction — a symbol has exactly one definition row
/// — and are deliberately not flagged. Caches keyed purely on CLR
/// reflection objects (<c>Type</c>, <c>MethodInfo</c>, ...) carry no
/// symbolic type parameters and are likewise exempt.
/// </para>
/// </remarks>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class EmitCacheKeyRemapScopeAnalyzer : DiagnosticAnalyzer
{
    private const string EmitNamespace = "GSharp.Core.CodeAnalysis.Emit";
    private const string SymbolsNamespace = "GSharp.Core.CodeAnalysis.Symbols";
    private const string RemapScopeTypeName = "RemapScope";
    private const int MaxDepth = 6;

    private static readonly ImmutableHashSet<string> SensitiveHandleTypes = ImmutableHashSet.Create(
        "global::System.Reflection.Metadata.EntityHandle",
        "global::System.Reflection.Metadata.MemberReferenceHandle",
        "global::System.Reflection.Metadata.TypeSpecificationHandle",
        "global::System.Reflection.Metadata.MethodSpecificationHandle");

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.EmitCacheKeyMissingRemapScope);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
        context.RegisterSymbolAction(AnalyzeProperty, SymbolKind.Property);
    }

    private static void AnalyzeField(SymbolAnalysisContext context)
    {
        var field = (IFieldSymbol)context.Symbol;
        if (field.IsImplicitlyDeclared)
        {
            return;
        }

        AnalyzeCacheMember(context, field, field.Type, field.Name);
    }

    private static void AnalyzeProperty(SymbolAnalysisContext context)
    {
        var property = (IPropertySymbol)context.Symbol;
        AnalyzeCacheMember(context, property, property.Type, property.Name);
    }

    private static void AnalyzeCacheMember(SymbolAnalysisContext context, ISymbol member, ITypeSymbol memberType, string memberName)
    {
        if (!IsEmitNamespace(member.ContainingNamespace))
        {
            return;
        }

        if (memberType is not INamedTypeSymbol namedType
            || namedType.TypeArguments.Length != 2
            || !IsDictionary(namedType))
        {
            return;
        }

        var keyType = namedType.TypeArguments[0];
        var valueType = namedType.TypeArguments[1];
        if (!Mentions(valueType, IsSensitiveHandle) || !Mentions(keyType, IsGSharpSymbolType))
        {
            return;
        }

        if (Mentions(keyType, IsRemapScope))
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(
            DiagnosticDescriptors.EmitCacheKeyMissingRemapScope,
            member.Locations.Length > 0 ? member.Locations[0] : null,
            memberName));
    }

    private static bool IsEmitNamespace(INamespaceSymbol namespaceSymbol)
    {
        var name = namespaceSymbol?.ToDisplayString();
        return name == EmitNamespace || (name != null && name.StartsWith(EmitNamespace + ".", System.StringComparison.Ordinal));
    }

    private static bool IsDictionary(INamedTypeSymbol type)
    {
        var metadataName = type.ConstructedFrom.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return metadataName == "global::System.Collections.Generic.Dictionary<TKey, TValue>"
            || metadataName == "global::System.Collections.Concurrent.ConcurrentDictionary<TKey, TValue>";
    }

    private static bool IsSensitiveHandle(ITypeSymbol type)
        => SensitiveHandleTypes.Contains(type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));

    private static bool IsGSharpSymbolType(ITypeSymbol type)
        => type.ContainingNamespace?.ToDisplayString() == SymbolsNamespace;

    private static bool IsRemapScope(ITypeSymbol type)
        => type.Name == RemapScopeTypeName && IsEmitNamespace(type.ContainingNamespace);

    /// <summary>
    /// Walks the structure of <paramref name="type"/> — tuple elements,
    /// generic type arguments, and the instance fields of user-defined key
    /// structs declared in the Emit namespace — looking for any component
    /// matching <paramref name="predicate"/>.
    /// </summary>
    private static bool Mentions(ITypeSymbol type, System.Func<ITypeSymbol, bool> predicate)
        => Mentions(type, predicate, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default), depth: 0);

    private static bool Mentions(ITypeSymbol type, System.Func<ITypeSymbol, bool> predicate, HashSet<ITypeSymbol> visited, int depth)
    {
        if (type == null || depth > MaxDepth || !visited.Add(type))
        {
            return false;
        }

        if (predicate(type))
        {
            return true;
        }

        if (type is IArrayTypeSymbol arrayType)
        {
            return Mentions(arrayType.ElementType, predicate, visited, depth + 1);
        }

        if (type is not INamedTypeSymbol namedType)
        {
            return false;
        }

        if (namedType.IsTupleType)
        {
            foreach (var element in namedType.TupleElements)
            {
                if (Mentions(element.Type, predicate, visited, depth + 1))
                {
                    return true;
                }
            }

            return false;
        }

        foreach (var typeArgument in namedType.TypeArguments)
        {
            if (Mentions(typeArgument, predicate, visited, depth + 1))
            {
                return true;
            }
        }

        // A user-defined composite key struct (e.g. MethodSpecSymbolKey)
        // declared in the Emit namespace: inspect its instance fields so both
        // the symbol mention and the RemapScope requirement see through it.
        if (namedType.IsValueType && IsEmitNamespace(namedType.ContainingNamespace))
        {
            foreach (var fieldMember in namedType.GetMembers())
            {
                if (fieldMember is IFieldSymbol { IsStatic: false } instanceField
                    && Mentions(instanceField.Type, predicate, visited, depth + 1))
                {
                    return true;
                }
            }
        }

        return false;
    }
}
