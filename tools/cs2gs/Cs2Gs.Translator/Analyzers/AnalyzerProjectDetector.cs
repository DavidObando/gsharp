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
    /// of an analyzer project (ADR-0169 M5, issue #3686): it declares an
    /// analyzer TEST HARNESS and instantiates an analyzer that lives in a
    /// referenced first-party assembly. Without this, the two halves of one
    /// project pair are translated against different analyzer APIs — the
    /// analyzer becomes a <c>GSharpDiagnosticAnalyzer</c> while its tests keep
    /// Roslyn's <c>DiagnosticAnalyzer</c> contract, and the migrated call sites
    /// fail with GS0154.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two signals must agree, because analyzer mode rewrites EVERY
    /// Microsoft.CodeAnalysis use in the project and therefore may only claim
    /// projects whose whole Roslyn surface it can map:
    /// </para>
    /// <list type="number">
    /// <item>the project declares an analyzer test harness — see
    /// <see cref="IsAnalyzerTestHarnessEntry"/>; and</item>
    /// <item>it instantiates, in source, a type deriving from
    /// <c>DiagnosticAnalyzer</c> that comes from an assembly OTHER than this
    /// compilation's own and other than Roslyn itself.</item>
    /// </list>
    /// <para>
    /// Issue #3789: instantiation ALONE is not the load-bearing shape. A
    /// project can construct an analyzer incidentally while being about
    /// something else — <c>tools/cs2gs/Cs2Gs.Tests</c> runs the repo's real
    /// GSA analyzers as a library to diff them against their translated
    /// counterparts, and its ~256 other Microsoft.CodeAnalysis uses are cs2gs
    /// machinery (<c>MetadataReference</c>, <c>CSharpCompilation</c>, …) that
    /// has, and should have, no analyzer-API mapping. Claiming it turned 14
    /// compile errors into 98 translate gaps. The harness is what makes a
    /// project an analyzer test project rather than an analyzer consumer, and
    /// it is also the ONLY thing analyzer mode does for a test project beyond
    /// what it does for an analyzer — so the detector and the rewrite share
    /// one predicate and cannot drift apart.
    /// </para>
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

        if (!DeclaresAnalyzerTestHarness(compilation))
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

    /// <summary>
    /// Recognizes the entry point of a Roslyn analyzer TEST harness: a static
    /// method that takes an analyzer and a source string, i.e. the repo's
    /// <c>AnalyzerTestHelper.AssertDiagnosticsAsync(DiagnosticAnalyzer, string, …)</c>
    /// shape. This is the one member analyzer mode rewrites specially for a
    /// test project (onto <c>GSharpAnalyzerVerifier.VerifyAnalyzer</c>), so it
    /// is exactly the surface whose presence justifies claiming the project:
    /// no harness, nothing for analyzer mode to do that ordinary mode does not
    /// do better. Lives here, next to the detector, so the two uses — deciding
    /// the mode and performing the rewrite — cannot diverge (#3789).
    /// </summary>
    /// <param name="symbol">The candidate method.</param>
    /// <returns>True when the method is an analyzer test harness entry point.</returns>
    public static bool IsAnalyzerTestHarnessEntry(IMethodSymbol symbol)
        => symbol is { IsStatic: true }
           && symbol.Parameters.Length >= 2
           && DerivesFromDiagnosticAnalyzer(symbol.Parameters[0].Type)
           && symbol.Parameters[1].Type.SpecialType == SpecialType.System_String;

    /// <summary>
    /// True when the compilation's own source declares an analyzer test
    /// harness entry point. Only declarations count: calling somebody else's
    /// verifier is not a harness this translator can rewrite.
    /// </summary>
    /// <param name="compilation">The bound C# compilation.</param>
    /// <returns>True when a harness entry point is declared in source.</returns>
    private static bool DeclaresAnalyzerTestHarness(CSharpCompilation compilation)
    {
        foreach (SyntaxTree tree in compilation.SyntaxTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            foreach (Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax method in
                tree.GetRoot().DescendantNodes()
                    .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(method) is IMethodSymbol symbol
                    && IsAnalyzerTestHarnessEntry(symbol))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Walks a type's base chain looking for Roslyn's analyzer base class by
    /// metadata name, so it works for symbols from any compilation (the
    /// translator calls it with symbols it did not resolve itself).
    /// </summary>
    /// <param name="type">The type to test.</param>
    /// <returns>True when the type derives from <c>DiagnosticAnalyzer</c>.</returns>
    private static bool DerivesFromDiagnosticAnalyzer(ITypeSymbol type)
    {
        for (ITypeSymbol current = type; current is not null; current = current.BaseType)
        {
            if (current is INamedTypeSymbol named
                && named.ContainingNamespace is { IsGlobalNamespace: false } ns
                && $"{ns.ToDisplayString()}.{named.Name}" == DiagnosticAnalyzerMetadataName)
            {
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
