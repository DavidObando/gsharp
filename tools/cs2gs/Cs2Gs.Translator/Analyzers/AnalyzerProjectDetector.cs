// <copyright file="AnalyzerProjectDetector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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

    /// <summary>
    /// Determines whether <paramref name="compilation"/> is the TEST project
    /// of an analyzer project (ADR-0169 M5, issue #3686): it declares no
    /// analyzer of its own, but instantiates one that lives in a referenced
    /// first-party assembly. Without this, the two halves of one project pair
    /// are translated against different analyzer APIs — the analyzer becomes a
    /// <c>GSharpDiagnosticAnalyzer</c> while its tests keep Roslyn's
    /// <c>DiagnosticAnalyzer</c> contract, and the migrated call sites fail
    /// with GS0154.
    /// </summary>
    /// <remarks>
    /// The probe is deliberately narrow: an <c>new SomeAnalyzer()</c> in
    /// source, where the created type derives from
    /// <c>DiagnosticAnalyzer</c> and comes from an assembly OTHER than this
    /// compilation's own and other than Roslyn itself. Instantiation is the
    /// load-bearing shape — a test that verifies an analyzer must construct
    /// one — and merely *referencing* Roslyn (as most tooling projects here
    /// do) must not flip a project into analyzer mode, because that mode
    /// rewrites every Microsoft.CodeAnalysis use in the project.
    /// </remarks>
    /// <param name="compilation">The bound C# compilation.</param>
    /// <returns>True when analyzer translation mode should be enabled.</returns>
    public static bool IsAnalyzerTestProject(CSharpCompilation compilation)
    {
        if (compilation?.GetTypeByMetadataName(DiagnosticAnalyzerMetadataName) is not { } analyzerBase)
        {
            return false;
        }

        if (IsAnalyzerProject(compilation))
        {
            return false;
        }

        foreach (SyntaxTree tree in compilation.SyntaxTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            foreach (Microsoft.CodeAnalysis.CSharp.Syntax.BaseObjectCreationExpressionSyntax creation in
                tree.GetRoot().DescendantNodes()
                    .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BaseObjectCreationExpressionSyntax>())
            {
                if (model.GetTypeInfo(creation).Type is not INamedTypeSymbol created)
                {
                    continue;
                }

                if (!DerivesFrom(created, analyzerBase))
                {
                    continue;
                }

                IAssemblySymbol declaring = created.ContainingAssembly;
                if (declaring is null
                    || SymbolEqualityComparer.Default.Equals(declaring, compilation.Assembly)
                    || IsRoslynAssembly(declaring))
                {
                    continue;
                }

                return true;
            }
        }

        return false;
    }

    private static bool IsRoslynAssembly(IAssemblySymbol assembly)
        => assembly.Name.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal);

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
