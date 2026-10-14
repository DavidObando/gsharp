// <copyright file="Adr0169Gsa0006ParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis.Diagnostics
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis

/// ADR-0169 §Parity for GSA0006 (issue #4172), following the same rationale
/// #3795 established for GSA0005 ((cref:Adr0169Gsa0005ParityTests)):
/// a corpus-level translate+compile guard proves the migrated analyzer
/// BUILDS, never that it still FIRES. GSA0006's own rollout found exactly
/// this gap — a compiling-but-silently-inert translated form is worse than a
/// translation failure, because nothing signals it. This class runs the
/// REAL Roslyn `BaseClassCycleUnsafeWalkAnalyzer` over each snippet,
/// translates BOTH the snippet and the analyzer with cs2gs, compiles the
/// translated analyzer with the real G# compiler, runs it over the
/// translated snippet through the same host `gsc` uses, and requires
/// the two diagnostic sets to match.
/// @remarks The negatives are non-vacuous BY CONSTRUCTION: the positives on this same
/// path assert the translated analyzer really fires, so "no diagnostics"
/// can no longer pass for the wrong reason (a rule that reports nothing at
/// all fails the positives too).
class Adr0169Gsa0006ParityTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-gsa0006-parity")

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    /// Roslyn GSA0006 and the cs2gs-translated GSA0006 must agree on every
    /// snippet of the fixture — including the negatives, which are only
    /// meaningful because the positives on this same path demand a
    /// diagnostic.
    /// @param name The fixture test the snippet comes from.
    /// @param csharpSource The C# snippet.
    /// @param expected The expected GSA0006 count.
    @Theory
    @MemberData("Snippets")
    func TranslatedGsa0006_MatchesRoslynGsa0006(name string, csharpSource string, expected int32) {
        Assert.Equal(expected, RunRoslynGsa0006(csharpSource))
        let snippet = SnippetTranslator.Translate(csharpSource)
        Assert.NotNull(snippet.GsWithMarkers)
        Assert.Empty(snippet.UnplacedMarkers)
        let produced = RunTranslatedGsa0006(snippet.GsWithMarkers)
        Assert.True(
            expected == produced,
            "$name: Roslyn GSA0006 produced $expected diagnostic(s), the translated analyzer produced $produced."
        )
    }

    private func RunTranslatedGsa0006(gsWithMarkers string?) int32 {
        let analyzerDll = CompileTranslatedGsa0006()
        let gs = gsWithMarkers!!.Replace("[|", string.Empty, StringComparison.Ordinal).Replace(
            "|]",
            string.Empty,
            StringComparison.Ordinal
        )
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(gs, "snippet.gs"))
        Assert.True(
            tree.Diagnostics.IsEmpty,
            string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))
        )
        using let resolver = ReferenceResolver.WithRuntimeReferences(Array.Empty[string]())
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree){IsLibrary = true}
        let errors = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToList()
        Assert.True(
            errors.Count == 0,
            string.Join("\n", errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)) + `
---
` + gs
        )
        let produced = GSharpAnalyzerHost.Run(compilation, []string{analyzerDll})
        Assert.DoesNotContain(
            produced,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> (d.Id is "GS9300" or "GS9301" or "GS9304")
        )
        return produced.Count((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GSA0006")
    }

    /// Translates the real GSA0006 source in analyzer mode and compiles it
    /// into a loadable G# analyzer assembly.
    /// @returns The analyzer assembly path.
    private func CompileTranslatedGsa0006() string {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "BaseClassCycleUnsafeWalkAnalyzer.cs",
                    FrozenCompilerSnapshots.Analyzer("BaseClassCycleUnsafeWalkAnalyzer.cs")
                ),
                ("DiagnosticDescriptors.cs", FrozenCompilerSnapshots.Analyzer("DiagnosticDescriptors.cs"))
            }
        )
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation))
        let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
        let trees = List[GSharp.Core.CodeAnalysis.Syntax.SyntaxTree]()
        for document in project.Documents.Where(
            (d LoadedDocument) -> Path.GetFileName(d.FilePath) != "GlobalUsings.cs"
        ) {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            trees.Add(
                GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SyntaxTree
                    .Parse(SourceText.From(printed, Path.GetFileName(document.FilePath) + ".gs"))
            )
        }
        Assert.All(
            trees,
            (tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree) -> Assert.True(
                tree.Diagnostics.IsEmpty,
                string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))
            )
        )
        using let resolver = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}
        )
        let compilation = GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation(resolver, trees.ToArray()){IsLibrary = true, AssemblyName = "TranslatedGsa0006"}
        let dllPath = Path.Combine(workDirectory.FullName, "TranslatedGsa0006.dll")
        {
            using let peStream = File.Create(dllPath)
            let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "TranslatedGsa0006")
            Assert.True(
                result.Success,
                "Translated GSA0006 should compile:\n" + string.Join(
                    "\n",
                    result
                        .Diagnostics
                        .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                        .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                )
            )
        }
        return dllPath
    }

    shared {
        /// The model every snippet shares: a minimal stand-in for `StructSymbol`.
        private const Model string = `class StructSymbol
{
    public StructSymbol BaseClass;
}`

        private const WhileLoopWalk string = `
class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            current = current.BaseClass;
        }
    }
}`

        // Issue #4177: a C-style for-loop whose increment clause is a general
        // assignment (not `++`/`--`) — exactly this shape — translates to
        // invalid G# in cs2gs's ordinary (non-analyzer) mode, a pre-existing,
        // unrelated gap discovered while writing this fixture. No known site
        // in src/Core hits it (every migrated for-loop increments by `level++`,
        // never by a general assignment), so it is not exercised here; add a
        // `ForLoopWalk` case back once #4177 is fixed.
        private const DoWhileLoopWalk string = `
class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            current = current.BaseClass;
        }
        while (current != null);
    }
}`

        private const SingleHopFetchIntoNewVariable string = `
class Checker
{
    bool HasBase(StructSymbol s)
    {
        var parent = s.BaseClass;
        return parent != null;
    }
}`

        private const GuardedWalkThroughHierarchyHelperModel string = `class StructSymbol
{
    public StructSymbol BaseClass;

    public System.Collections.Generic.List<StructSymbol> GetHierarchy()
    {
        var hierarchy = new System.Collections.Generic.List<StructSymbol>();
        var current = this;
        while (current != null)
        {
            hierarchy.Add(current);
            current = current.BaseClass;
        }

        return hierarchy;
    }
}`

        private const GuardedWalkThroughHierarchyHelper string = `
class Walker
{
    bool FindAncestor(StructSymbol container, StructSymbol target)
    {
        var chain = container.GetHierarchy();
        for (var i = 1; i < chain.Count; i++)
        {
            if (chain[i] == target)
            {
                return true;
            }
        }

        return false;
    }
}`

        /// The fixture's snippets, each with the number of GSA0006 diagnostics the
        /// REAL Roslyn analyzer produces. The count is asserted against Roslyn
        /// too, so a wrong expectation fails on the C# side rather than silently
        /// weakening the G# side.
        /// @returns Snippet name, source, expected diagnostic count.
        func Snippets() TheoryData[string, string, int32] -> {
            let values = TheoryData[string, string, int32]()
            values.Add("ReportsWhileLoopWalk", Model + WhileLoopWalk, 1)
            values.Add("ReportsDoWhileLoopWalk", Model + DoWhileLoopWalk, 1)
            values.Add("IgnoresSingleHopFetchIntoNewVariable", Model + SingleHopFetchIntoNewVariable, 0)
            values.Add(
                "IgnoresGuardedWalkThroughHierarchyHelper",
                GuardedWalkThroughHierarchyHelperModel + GuardedWalkThroughHierarchyHelper,
                0
            )
            values
        }

        private func RunRoslynGsa0006(csharpSource string) int32 {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, csharpSource string){("Snippet.cs", csharpSource)}
            )
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            // Issue #3880: see Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer —
            // the control is compiled from the analyzer's own source so the Roslyn
            // half of the parity check survives self-migration.
            let roslynAnalyzer DiagnosticAnalyzer? = Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer(
                "BaseClassCycleUnsafeWalkAnalyzer.cs",
                "BaseClassCycleUnsafeWalkAnalyzer"
            )
            return project
                .Compilation
                .WithAnalyzers(ImmutableArray.Create[DiagnosticAnalyzer](roslynAnalyzer!!))
                .GetAnalyzerDiagnosticsAsync()
                .GetAwaiter()
                .GetResult()
                .Count((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id == "GSA0006")
        }
    }
}
