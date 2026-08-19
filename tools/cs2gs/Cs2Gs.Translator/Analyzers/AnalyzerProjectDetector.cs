// <copyright file="AnalyzerProjectDetector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Cs2Gs.Translator.Analyzers;

/// <summary>
/// Detects Roslyn analyzer projects for analyzer translation mode (ADR-0169,
/// docs/cs2gs-analyzer-translation.md §Detection). The semantic check is
/// authoritative: a project is an analyzer project iff its compilation
/// resolves <c>Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer</c> and
/// at least one source type derives from it. csproj heuristics
/// (<c>EnforceExtendedAnalyzerRules</c>, Microsoft.CodeAnalysis packages)
/// belong to the project transformer, which has no compilation.
/// </summary>
public static class AnalyzerProjectDetector
{
    /// <summary>The metadata name of Roslyn's analyzer base class.</summary>
    public const string DiagnosticAnalyzerMetadataName = "Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer";

    /// <summary>
    /// Determines whether <paramref name="compilation"/> declares at least one
    /// Roslyn diagnostic analyzer.
    /// </summary>
    /// <param name="compilation">The bound C# compilation.</param>
    /// <returns>True when analyzer translation mode should be enabled.</returns>
    public static bool IsAnalyzerProject(CSharpCompilation compilation)
    {
        if (compilation?.GetTypeByMetadataName(DiagnosticAnalyzerMetadataName) is not { } analyzerBase)
        {
            return false;
        }

        return compilation.SyntaxTrees
            .Select(tree => compilation.GetSemanticModel(tree))
            .SelectMany(model => model.SyntaxTree.GetRoot().DescendantNodes()
                .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax>()
                .Select(declaration => model.GetDeclaredSymbol(declaration)))
            .OfType<INamedTypeSymbol>()
            .Any(type => DerivesFrom(type, analyzerBase));
    }

    private static bool DerivesFrom(INamedTypeSymbol type, INamedTypeSymbol candidateBase)
    {
        for (INamedTypeSymbol current = type.BaseType; current is not null; current = current.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(current, candidateBase))
            {
                return true;
            }
        }

        return false;
    }
}
