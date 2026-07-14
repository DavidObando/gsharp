// <copyright file="StrongStaticReflectionCacheAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// Flags static dictionaries that strongly hold reflection identity keys.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class StrongStaticReflectionCacheAnalyzer : DiagnosticAnalyzer
{
    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.StrongStaticReflectionCache);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
    }

    private static void AnalyzeField(SymbolAnalysisContext context)
    {
        var field = (IFieldSymbol)context.Symbol;
        if (!field.IsStatic || !IsCompilerMetadataArea(field.ContainingNamespace))
        {
            return;
        }

        if (field.Type is not INamedTypeSymbol namedType || namedType.TypeArguments.Length != 2 || !IsStrongDictionary(namedType))
        {
            return;
        }

        var keyType = namedType.TypeArguments[0];
        if (IsReflectionIdentityType(keyType))
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticDescriptors.StrongStaticReflectionCache,
                field.Locations.Length > 0 ? field.Locations[0] : null,
                keyType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
        }
    }

    private static bool IsCompilerMetadataArea(INamespaceSymbol namespaceSymbol)
    {
        var namespaceName = namespaceSymbol?.ToDisplayString();
        return namespaceName == "GSharp.Core.CodeAnalysis.Emit"
            || namespaceName == "GSharp.Core.CodeAnalysis.Symbols"
            || namespaceName == "GSharp.Core.CodeAnalysis.Binding";
    }

    private static bool IsStrongDictionary(INamedTypeSymbol type)
    {
        var metadataName = type.ConstructedFrom.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return metadataName == "global::System.Collections.Generic.Dictionary<TKey, TValue>"
            || metadataName == "global::System.Collections.Concurrent.ConcurrentDictionary<TKey, TValue>";
    }

    private static bool IsReflectionIdentityType(ITypeSymbol type)
    {
        return type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.Type"
            || type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.Reflection.Assembly"
            || type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.Reflection.Module";
    }
}
