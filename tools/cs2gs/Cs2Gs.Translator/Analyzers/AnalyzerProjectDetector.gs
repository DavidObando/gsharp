// <copyright file="AnalyzerProjectDetector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Analyzers

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Linq

/// Detects Roslyn analyzer projects for analyzer translation mode (ADR-0169,
/// docs/cs2gs-analyzer-translation.md §Detection). The semantic check is
/// authoritative: a project is an analyzer project iff its compilation
/// resolves `Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer` and
/// at least one source type derives from it. csproj heuristics
/// (`EnforceExtendedAnalyzerRules`, Microsoft.CodeAnalysis packages)
/// belong to the project transformer, which has no compilation.
shared class AnalyzerProjectDetector {
    /// The metadata name of Roslyn's analyzer base class.
    const DiagnosticAnalyzerMetadataName string = "Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer"

    /// Determines whether [`compilation`](paramref) declares at least one
    /// Roslyn diagnostic analyzer.
    /// @param compilation The bound C# compilation.
    /// @returns True when analyzer translation mode should be enabled.
    func IsAnalyzerProject(compilation CSharpCompilation?) bool {
        if compilation?.GetTypeByMetadataName(DiagnosticAnalyzerMetadataName) is not{} analyzerBase {
            return false
        }
        // Issue #4612: a declaration without a symbol is skipped here rather
        // than projected to null and filtered by OfType afterwards. The
        // migrated G# asserts a lambda result stored into a type-parameter
        // slot, so a null result would throw there.
        return compilation!!
            .SyntaxTrees
            .Select((tree SyntaxTree) -> compilation!!.GetSemanticModel(tree))
            .Any(
            (model SemanticModel) -> model
                .SyntaxTree
                .GetRoot()
                .DescendantNodes()
                .OfType[TypeDeclarationSyntax]()
                .Any(
                (declaration TypeDeclarationSyntax) -> model.GetDeclaredSymbol(declaration) is INamedTypeSymbol type &&
                    DerivesFrom(type, analyzerBase)
            )
        )
    }

    /// Determines whether [`compilation`](paramref) is the TEST project
    /// of an analyzer project (ADR-0169 M5, issue #3686): it declares an
    /// analyzer TEST HARNESS and instantiates an analyzer that lives in a
    /// referenced first-party assembly. Without this, the two halves of one
    /// project pair are translated against different analyzer APIs — the
    /// analyzer becomes a `GSharpDiagnosticAnalyzer` while its tests keep
    /// Roslyn's `DiagnosticAnalyzer` contract, and the migrated call sites
    /// fail with GS0154.
    /// @remarks Two signals must agree, because analyzer mode rewrites EVERY
    /// Microsoft.CodeAnalysis use in the project and therefore may only claim
    /// projects whose whole Roslyn surface it can map:
    ///
    /// 1. the project declares an analyzer test harness — see (cref:IsAnalyzerTestHarnessEntry); and
    /// 2. it instantiates, in source, a type deriving from `DiagnosticAnalyzer` that comes from an assembly
    /// OTHER than this compilation's own and other than Roslyn itself.
    ///
    /// Issue #3789: instantiation ALONE is not the load-bearing shape. A
    /// project can construct an analyzer incidentally while being about
    /// something else — `tools/cs2gs/Cs2Gs.Tests` runs the repo's real
    /// GSA analyzers as a library to diff them against their translated
    /// counterparts, and its ~256 other Microsoft.CodeAnalysis uses are cs2gs
    /// machinery (`MetadataReference`, `CSharpCompilation`, …) that
    /// has, and should have, no analyzer-API mapping. Claiming it turned 14
    /// compile errors into 98 translate gaps. The harness is what makes a
    /// project an analyzer test project rather than an analyzer consumer, and
    /// it is also the ONLY thing analyzer mode does for a test project beyond
    /// what it does for an analyzer — so the detector and the rewrite share
    /// one predicate and cannot drift apart.
    /// @param compilation The bound C# compilation.
    /// @returns True when analyzer translation mode should be enabled.
    func IsAnalyzerTestProject(compilation CSharpCompilation?) bool {
        if compilation?.GetTypeByMetadataName(DiagnosticAnalyzerMetadataName) is not{} analyzerBase {
            return false
        }
        if IsAnalyzerProject(compilation) {
            return false
        }
        if !DeclaresAnalyzerTestHarness(compilation) {
            return false
        }
        for tree in compilation!!.SyntaxTrees {
            let model = compilation!!.GetSemanticModel(tree)
            for creation in tree.GetRoot().DescendantNodes().OfType[BaseObjectCreationExpressionSyntax]() {
                if model.GetTypeInfo(creation).Type is not INamedTypeSymbol created {
                    continue
                }
                if !DerivesFrom(created, analyzerBase) {
                    continue
                }
                let declaring IAssemblySymbol? = created.ContainingAssembly
                if declaring == nil || SymbolEqualityComparer.Default.Equals(declaring, compilation!!.Assembly) ||
                    IsRoslynAssembly(declaring) {
                    continue
                }
                return true
            }
        }
        return false
    }

    /// Recognizes the entry point of a Roslyn analyzer TEST harness: a static
    /// method that takes an analyzer and a source string, i.e. the repo's
    /// `AnalyzerTestHelper.AssertDiagnosticsAsync(DiagnosticAnalyzer, string, …)`
    /// shape. This is the one member analyzer mode rewrites specially for a
    /// test project (onto `GSharpAnalyzerVerifier.VerifyAnalyzer`), so it
    /// is exactly the surface whose presence justifies claiming the project:
    /// no harness, nothing for analyzer mode to do that ordinary mode does not
    /// do better. Lives here, next to the detector, so the two uses — deciding
    /// the mode and performing the rewrite — cannot diverge (#3789).
    /// @param symbol The candidate method.
    /// @returns True when the method is an analyzer test harness entry point.
    func IsAnalyzerTestHarnessEntry(symbol IMethodSymbol?) bool -> symbol != nil &&
        symbol.IsStatic == true &&
        symbol
        .Parameters
        .Length >= 2 &&
        DerivesFromDiagnosticAnalyzer(symbol.Parameters[0].Type) &&
        symbol
        .Parameters[1]
        .Type
        .SpecialType == SpecialType.System_String

    /// True when the compilation's own source declares an analyzer test
    /// harness entry point. Only declarations count: calling somebody else's
    /// verifier is not a harness this translator can rewrite.
    /// @param compilation The bound C# compilation.
    /// @returns True when a harness entry point is declared in source.
    private func DeclaresAnalyzerTestHarness(compilation CSharpCompilation?) bool {
        for tree in compilation!!.SyntaxTrees {
            let model = compilation!!.GetSemanticModel(tree)
            for method in tree.GetRoot().DescendantNodes().OfType[MethodDeclarationSyntax]() {
                if model.GetDeclaredSymbol(method) is IMethodSymbol symbol && IsAnalyzerTestHarnessEntry(symbol) {
                    return true
                }
            }
        }
        return false
    }

    /// Walks a type's base chain looking for Roslyn's analyzer base class by
    /// metadata name, so it works for symbols from any compilation (the
    /// translator calls it with symbols it did not resolve itself).
    /// @param type The type to test.
    /// @returns True when the type derives from `DiagnosticAnalyzer`.
    private func DerivesFromDiagnosticAnalyzer(type ITypeSymbol) bool {
        for var current ITypeSymbol? = type; current != nil; current = current!!.BaseType {
            if current is INamedTypeSymbol named &&
                named.ContainingNamespace is {IsGlobalNamespace: false} ns &&
                "${ns.ToDisplayString()}.${named.Name}" == DiagnosticAnalyzerMetadataName {
                return true
            }
        }
        return false
    }

    private func IsRoslynAssembly(assembly IAssemblySymbol?) bool -> assembly!!.Name.StartsWith(
        "Microsoft.CodeAnalysis",
        StringComparison.Ordinal
    )

    private func DerivesFrom(type INamedTypeSymbol, candidateBase INamedTypeSymbol) bool {
        for var current INamedTypeSymbol? = type.BaseType; current != nil; current = current!!.BaseType {
            if SymbolEqualityComparer.Default.Equals(current, candidateBase) {
                return true
            }
        }
        return false
    }
}
