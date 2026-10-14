// <copyright file="Adr0169Gsa0005ParityTests.cs" company="GSharp">
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

/// ADR-0169 §Parity for GSA0005 (issue #3795). The corpus-level parity harness
/// covered GSA0001 only, so a translated rule that stopped firing altogether
/// passed every negative test and was caught only by a full migration run —
/// which is exactly how #3795 escaped. This class runs the REAL Roslyn
/// `RewriterClonePreservationAnalyzer` over each snippet of
/// `test/InternalAnalyzers.Tests`, translates BOTH the snippet and the
/// analyzer with cs2gs, compiles the translated analyzer with the real G#
/// compiler, runs it over the translated snippet through the same host gsc
/// uses, and requires the two diagnostic sets to match.
/// @remarks The negatives are non-vacuous BY CONSTRUCTION: they share one parameterised
/// path with the positives, and the positives assert the translated analyzer
/// really fires. A rule that reports nothing fails the positives, so "no
/// diagnostics" can no longer pass for the wrong reason.
class Adr0169Gsa0005ParityTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-gsa0005-parity")

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    /// Roslyn GSA0005 and the cs2gs-translated GSA0005 must agree on every
    /// snippet of the fixture — including the negatives, which are only
    /// meaningful because the positives on this same path demand a diagnostic.
    /// @param name The fixture test the snippet comes from.
    /// @param csharpSource The C# snippet.
    /// @param expected The expected GSA0005 count.
    @Theory
    @MemberData("Snippets")
    func TranslatedGsa0005_MatchesRoslynGsa0005(name string, csharpSource string, expected int32) {
        Assert.Equal(expected, RunRoslynGsa0005(csharpSource))
        let snippet = SnippetTranslator.Translate(csharpSource)
        Assert.NotNull(snippet.GsWithMarkers)
        Assert.Empty(snippet.UnplacedMarkers)
        let produced = RunTranslatedGsa0005(snippet.GsWithMarkers)
        Assert.True(
            expected == produced,
            "$name: Roslyn GSA0005 produced $expected diagnostic(s), the translated analyzer produced $produced."
        )
    }

    private func RunTranslatedGsa0005(gsWithMarkers string?) int32 {
        let analyzerDll = CompileTranslatedGsa0005()
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
        return produced.Count((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GSA0005")
    }

    /// Translates the real GSA0005 source in analyzer mode and compiles it into
    /// a loadable G# analyzer assembly.
    /// @returns The analyzer assembly path.
    private func CompileTranslatedGsa0005() string {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "RewriterClonePreservationAnalyzer.cs",
                    FrozenCompilerSnapshots.Analyzer("RewriterClonePreservationAnalyzer.cs")
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
            .Compilation(resolver, trees.ToArray()){IsLibrary = true, AssemblyName = "TranslatedGsa0005"}
        let dllPath = Path.Combine(workDirectory.FullName, "TranslatedGsa0005.dll")
        {
            using let peStream = File.Create(dllPath)
            let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "TranslatedGsa0005")
            Assert.True(
                result.Success,
                "Translated GSA0005 should compile:\n" + string.Join(
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
        /// The two-form union the fixture shares: a variable-receiver constructor
        /// and an interface-static one, the latter omitting `Receiver` and
        /// carrying `InterfaceType` instead. Copied verbatim from
        /// `RewriterClonePreservationAnalyzerTests` so parity is measured on
        /// the shapes the migrated suite actually runs.
        private const Model string = `class Node { }

class FieldNode : Node
{
    public FieldNode(Node receiver, string field, Node value) { Receiver = receiver; Field = field; Value = value; }

    public FieldNode(string field, string interfaceType, Node value) { Field = field; InterfaceType = interfaceType; Value = value; }

    public Node Receiver { get; }

    public string InterfaceType { get; }

    public string Field { get; }

    public Node Value { get; }
}

class BoundTreeRewriter
{
    protected virtual Node RewriteFieldNode(FieldNode node)
    {
        var value = node.Value;
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, value)
            : new FieldNode(node.Receiver, node.Field, value);
    }
}`

        private const RebuildsWithoutDiscriminator string = `
class Broken : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return new FieldNode(node.Receiver, node.Field, node.Value);
    }
}`

        private const BranchesOnDiscriminator string = `
class Fixed : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}`

        private const DoesNotRebuild string = `
class Delegating : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.Field == "skip" ? node : base.RewriteFieldNode(node);
    }
}`

        private const DelegatesOnOnePathOnly string = `
class PartlyDelegating : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        if (node.Field == "skip")
        {
            return base.RewriteFieldNode(node);
        }

        return new FieldNode(node.Receiver, node.Field, node.Value);
    }
}`

        private const ReplacesEveryFormsMember string = `
class Replacing : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, new Node())
            : new FieldNode(node.Receiver, node.Field, new Node());
    }
}`

        private const ReadsThroughAHelper string = `
class ViaHelper : BoundTreeRewriter
{
    private static string Discriminator(FieldNode node) => node.InterfaceType;

    protected override Node RewriteFieldNode(FieldNode node)
    {
        var owner = Discriminator(node);
        return owner != null
            ? new FieldNode(node.Field, owner, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}`

        private const ReadsThroughTheRewrittenBaseResult string = `
class ViaBaseResult : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        var rewritten = (FieldNode)base.RewriteFieldNode(node);
        return rewritten.InterfaceType != null
            ? new FieldNode(rewritten.Field, rewritten.InterfaceType, rewritten.Value)
            : new FieldNode(rewritten.Receiver, rewritten.Field, rewritten.Value);
    }
}`

        /// The fixture's snippets, each with the number of GSA0005 diagnostics the
        /// REAL Roslyn analyzer produces. The count is asserted against Roslyn too,
        /// so a wrong expectation fails on the C# side rather than silently
        /// weakening the G# side.
        /// @returns Snippet name, source, expected diagnostic count.
        func Snippets() TheoryData[string, string, int32] -> {
            let values = TheoryData[string, string, int32]()
            values.Add("ReportsAnOverrideThatRebuildsWithoutTheDiscriminator", Model + RebuildsWithoutDiscriminator, 1)
            values.Add("DelegatingOnOnePathDoesNotExcuseDroppingOnAnother", Model + DelegatesOnOnePathOnly, 1)
            values.Add("AcceptsAnOverrideThatBranchesOnTheDiscriminator", Model + BranchesOnDiscriminator, 0)
            values.Add("AcceptsAnOverrideThatDoesNotRebuild", Model + DoesNotRebuild, 0)
            values.Add("IgnoresMembersEveryConstructorRequires", Model + ReplacesEveryFormsMember, 0)
            values.Add("AcceptsReadsReachedThroughAHelper", Model + ReadsThroughAHelper, 0)
            values.Add("AcceptsReadsThroughTheRewrittenBaseResult", Model + ReadsThroughTheRewrittenBaseResult, 0)
            values
        }

        private func RunRoslynGsa0005(csharpSource string) int32 {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, csharpSource string){("Snippet.cs", csharpSource)}
            )
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            // Issue #3880: see Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer —
            // the control is compiled from the analyzer's own source so the Roslyn
            // half of the parity check survives self-migration.
            let roslynAnalyzer DiagnosticAnalyzer? = Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer(
                "RewriterClonePreservationAnalyzer.cs",
                "RewriterClonePreservationAnalyzer"
            )
            return project
                .Compilation
                .WithAnalyzers(ImmutableArray.Create[DiagnosticAnalyzer](roslynAnalyzer!!))
                .GetAnalyzerDiagnosticsAsync()
                .GetAwaiter()
                .GetResult()
                .Count((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id == "GSA0005")
        }
    }
}
