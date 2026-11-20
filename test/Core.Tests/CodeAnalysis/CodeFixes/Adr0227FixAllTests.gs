// <copyright file="Adr0227FixAllTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Threading
import Xunit

/// ADR-0227 D3: the batch FixAll at document, project and solution scope, the overlap policy,
/// rounds, the applicability filter, the gate and determinism.
open class Adr0227FixAllTests {
    const TwoNulls string = "package P\n\nfunc F() string? {\n    // a\n    return null\n}\n\nfunc G() string? -> null\n"

    @Fact
    func DocumentScope_FixesEveryDiagnosticWithTheKey() {
        let tree = SyntaxTree.Parse(SourceText.From(TwoNulls, "a.gs"))
        let compilation = Compilation(tree)
        let result = Service().FixAll(FixAllScope.Document(compilation, tree), "GS0273.UseNil")
        Assert.Equal(2, result.Applied.Length)
        Assert.Empty(result.Dropped)
        let document = Assert.Single(result.Documents)
        Assert.Equal(
            "package P\n\nfunc F() string? {\n    // a\n    return nil\n}\n\nfunc G() string? -> nil\n",
            document.Changed.Text.ToString()
        )
        Assert.Empty(Assert.Single(result.Compilations).GetDiagnostics())
        Assert.Same(tree, Assert.Single(compilation.SyntaxTrees))
        // One change between the common prefix and suffix rebuilds the changed text.
        let changes = document.GetChanges()
        Assert.Single(changes)
        Assert.Equal(document.Changed.Text.ToString(), document.Original.Text.WithChanges(changes).ToString())
    }

    @Fact
    func OverlappingFixes_TheFirstWins_AndASecondRoundAppliesTheRest() {
        const source = "package P\n\nfunc Use(a string?, b string?) int32 -> 0\n\nfunc F() int32 -> Use(null,null)\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let registry = CodeFixRegistry()
        registry.Add(WideNilProvider())
        let service = CodeFixService(registry)
        let one = service.FixAll(FixAllScope.Document(compilation, tree), "wide")
        Assert.Single(one.Applied)
        let dropped = Assert.Single(one.Dropped)
        Assert.Equal(FixDropReason.Overlap, dropped.Reason)
        Assert.Contains("Use(nil,null)", Assert.Single(one.Documents).Changed.Text.ToString())
        let options = FixAllOptions()
        options.MaxRounds = 3
        let all = service.FixAll(FixAllScope.Document(compilation, tree), "wide", options)
        Assert.Equal(2, all.Applied.Length)
        Assert.Equal(2, all.Rounds)
        Assert.Contains("Use(nil,nil)", Assert.Single(all.Documents).Changed.Text.ToString())
    }

    @Fact
    func ApplicabilityFilter_DefaultsToMachineApplicable() {
        const source = "package P\n\nfunc F(a bool) bool {\n    if not a {\n        return false\n    }\n    return true\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let filtered = Service().FixAll(FixAllScope.Document(compilation, tree), "LogicalWord.not")
        Assert.Empty(filtered.Applied)
        Assert.Equal(FixDropReason.ApplicabilityFiltered, Assert.Single(filtered.Dropped).Reason)
        let options = FixAllOptions()
        options.MinimumApplicability = Applicability.MaybeIncorrect
        let applied = Service().FixAll(FixAllScope.Document(compilation, tree), "LogicalWord.not", options)
        Assert.Contains("if !a {", Assert.Single(applied.Documents).Changed.Text.ToString())
    }

    @Fact
    func Gate_RejectsARoundThatAddsADiagnostic() {
        const source = "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32 {\n    return c.N\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let options = FixAllOptions()
        options.MinimumApplicability = Applicability.MaybeIncorrect
        options.Gate = DeltaPolicy.NoNewDiagnostics
        let result = Service().FixAll(FixAllScope.Document(compilation, tree), "GS0158.NullConditionalAccess", options)
        Assert.Empty(result.Applied)
        Assert.Empty(result.Documents)
        Assert.Equal(FixDropReason.DeltaRejected, Assert.Single(result.Dropped).Reason)
    }

    @Fact
    func ProjectAndSolutionScopes_FixEveryTree_Deterministically() {
        let a = SyntaxTree.Parse(SourceText.From("package P\n\nfunc A() string? -> null\n", "a.gs"))
        let b = SyntaxTree.Parse(SourceText.From("package P\n\nfunc B() string? -> null\n", "b.gs"))
        let c = SyntaxTree.Parse(SourceText.From("package Q\n\nfunc C() string? -> null\n", "c.gs"))
        let first = Compilation(a, b)
        let second = Compilation(c)
        let project = Service().FixAll(FixAllScope.Project(first), "GS0273.UseNil")
        Assert.Equal(
            []string{"a.gs", "b.gs"},
            project.Documents.Select((d FixAllDocument) -> d.Original.Text.FileName).ToArray()
        )
        let reversed = Service().FixAll(FixAllScope.Project(Compilation(b, a)), "GS0273.UseNil")
        Assert.Equal(
            project.Documents.Select((d FixAllDocument) -> d.Changed.Text.ToString()).ToArray(),
            reversed.Documents.Select((d FixAllDocument) -> d.Changed.Text.ToString()).ToArray()
        )
        let solution = Service().FixAll(FixAllScope.Solution(ImmutableArray.Create(first, second)), "GS0273.UseNil")
        Assert.Equal(3, solution.Applied.Length)
        Assert.Equal(3, solution.Documents.Length)
        Assert.Equal(2, solution.Compilations.Length)
        for run in Enumerable.Range(0, 5) {
            let again = Service().FixAll(FixAllScope.Solution(ImmutableArray.Create(first, second)), "GS0273.UseNil")
            Assert.Equal(
                solution.Documents.Select((d FixAllDocument) -> d.Changed.Text.ToString()).ToArray(),
                again.Documents.Select((d FixAllDocument) -> d.Changed.Text.ToString()).ToArray()
            )
        }
    }

    @Fact
    func NullKey_TakesTheFirstFixOfEachDiagnostic() {
        const source = "package P\n\nfunc F(a bool, b bool) bool {\n    let x = new System.Text.StringBuilder()\n    return a or b\n}\n"
        let tree = SyntaxTree.Parse(source)
        let result = Service().FixAll(FixAllScope.Document(Compilation(tree), tree), nil)
        Assert.Contains("return a || b", Assert.Single(result.Documents).Changed.Text.ToString())
    }

    @Fact
    func DocumentScope_ReportsEveryTreeThatAFixChanges() {
        let a = SyntaxTree.Parse(SourceText.From("package P\n\nfunc A() string? -> null\n", "a.gs"))
        let b = SyntaxTree.Parse(SourceText.From("package P\n\nfunc B() int32 -> 1\n", "b.gs"))
        let compilation = Compilation(a, b)
        let result = Registry(CompanionEditProvider(b)).FixAll(FixAllScope.Document(compilation, a), "companion")
        Assert.Equal(
            []string{"a.gs", "b.gs"},
            result.Documents.Select((d FixAllDocument) -> d.Original.Text.FileName).ToArray()
        )
    }

    @Fact
    func DeferredProviderFailure_IsDroppedAndTheRunGoesOn() {
        let tree = SyntaxTree.Parse(TwoNulls)
        let result = Registry(ThrowingComputeProvider()).FixAll(FixAllScope.Document(Compilation(tree), tree), "throws")
        Assert.Empty(result.Applied)
        Assert.Equal(2, result.Dropped.Count((d DroppedFix) -> d.Reason == FixDropReason.ProviderFailed))
    }

    @Fact
    func Gate_SeesEveryDeclaredTarget() {
        const source = "package P\n\nfunc F() string? -> null\n\nfunc G() int32 -> missing\n"
        let tree = SyntaxTree.Parse(source)
        let options = FixAllOptions()
        options.Gate = DeltaPolicy.RemovesTargetNoNewErrors
        // The fix declares GS0273 and GS0125 as targets but removes only GS0273.
        let result = Registry(TwoTargetProvider()).FixAll(FixAllScope.Document(Compilation(tree), tree), "two", options)
        Assert.Empty(result.Applied)
        Assert.Equal(FixDropReason.DeltaRejected, Assert.Single(result.Dropped).Reason)
    }

    @Fact
    func OverlappingFixes_TheEarlierInSourceWins_WhateverTheDiagnosticOrder() {
        // The global's GS0273 is a declaration diagnostic, reported before the body's, but it is later in the file.
        const source = "package P\n\nfunc F() string? -> null\n\nlet g string? = null\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let result = Registry(ToEndProvider()).FixAll(FixAllScope.Document(compilation, tree), "to-end")
        let applied = Assert.Single(result.Applied)
        Assert.Equal(source.IndexOf("null", StringComparison.Ordinal), applied.Diagnostics[0].Location.Span.Start)
    }

    @Fact
    func AnalyzerDiagnostics_AreFixedWhenTheOptionsNameTheAnalyzers() {
        let tree = SyntaxTree.Parse(SourceText.From("package P\n\nfunc F() int32 -> 1\n", "a.gs"))
        let options = FixAllOptions()
        let deltaOptions = DeltaOptions()
        deltaOptions.Analyzers = ImmutableArray.Create[GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer](
            PackageAnalyzer()
        )
        options.DeltaOptions = deltaOptions
        let result = Registry(PackageFixProvider()).FixAll(
            FixAllScope.Document(Compilation(tree), tree),
            "package",
            options
        )
        Assert.Contains("package Q", Assert.Single(result.Documents).Changed.Text.ToString())
    }

    @Fact
    func InvalidRawEdits_AreProviderFailures_AndTheOtherFixesApply() {
        // Diagnostics without compiler suggestions, so each provider's fix is the only fix.
        const source = "package P\n\nfunc F() int32 {\n    let x = 1\n    x = 2\n    return x\n}\n\nfunc G() int32 -> missing\n"
        let tree = SyntaxTree.Parse(source)
        let registry = CodeFixRegistry()
        registry.Add(OutOfBoundsProvider())
        registry.Add(MissingToOneProvider())
        let result = CodeFixService(registry).FixAll(FixAllScope.Document(Compilation(tree), tree), nil)
        Assert.Equal(FixDropReason.ProviderFailed, Assert.Single(result.Dropped).Reason)
        Assert.Contains("func G() int32 -> 1", Assert.Single(result.Documents).Changed.Text.ToString())
    }

    @Fact
    func SupportsFixAll_IsReadFromTheRegisteringProvider() {
        let tree = SyntaxTree.Parse(TwoNulls)
        let registry = CodeFixRegistry()
        registry.Add(NamedNilProvider("shared.id", true))
        registry.Add(NamedNilProvider("other.id", false, "shared.id"))
        let result = CodeFixService(registry).FixAll(FixAllScope.Document(Compilation(tree), tree), "opted-out")
        Assert.Empty(result.Applied)
        Assert.All(result.Dropped, (d DroppedFix) -> Assert.Equal(FixDropReason.NotSupported, d.Reason))
        Assert.NotEmpty(result.Dropped)
    }

    @Fact
    func ConflictWinner_DoesNotDependOnTheTreeOrder() {
        let a = SyntaxTree.Parse(SourceText.From("package P\n\nfunc A() string? -> null\n", "a.gs"))
        let b = SyntaxTree.Parse(SourceText.From("package P\n\nfunc B() string? -> null\n", "b.gs"))
        let forward = Registry(CrossFileProvider()).FixAll(FixAllScope.Project(Compilation(a, b)), "cross")
        let reversed = Registry(CrossFileProvider()).FixAll(FixAllScope.Project(Compilation(b, a)), "cross")
        Assert.Equal("a.gs", Assert.Single(forward.Applied).Diagnostics[0].Location.Text!!.FileName)
        Assert.Equal("a.gs", Assert.Single(reversed.Applied).Diagnostics[0].Location.Text!!.FileName)
    }

    // Every fix inserts a marker at the start of both files, so any two fixes conflict.
    private class CrossFileProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let trees = context.Compilation.SyntaxTrees
            context.RegisterFix(
                CodeFix(
                    "cross",
                    "cross",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic),
                    "test.cross",
                    (ct CancellationToken) -> FixChanges(
                        trees.Select(
                            (t SyntaxTree) -> DocumentChanges(
                                t,
                                ImmutableArray.Create(TextChange(TextSpan(0, 0), "// x\n")),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                            .ToImmutableArray()
                    )
                )
            )
        }
    }

    // A fix whose change ends after the end of the text.
    private class OutOfBoundsProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0127")

        override func RegisterCodeFixes(context CodeFixContext) {
            let tree = context.Tree
            context.RegisterFix(
                CodeFix(
                    "bounds",
                    "bounds",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic),
                    "test.bounds",
                    (ct CancellationToken) -> FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(
                                tree,
                                ImmutableArray.Create(TextChange(TextSpan(tree.Text.Length - 1, 10), "x")),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                    )
                )
            )
        }
    }

    private class MissingToOneProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0125")

        override func RegisterCodeFixes(context CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                "one",
                "one",
                Applicability.MachineApplicable,
                (editor SyntaxEditor) -> editor.ReplaceToken(token, "1")
            )
        }
    }

    // A provider with a chosen ID and FixAll support, whose fixes can claim another provider's ID.
    private class NamedNilProvider : GSharpCodeFixProvider {
        private let name string
        private let fixAll bool
        private let claimedId string?

        init(name string, fixAll bool, claimedId string? = nil) {
            this.name = name
            this.fixAll = fixAll
            this.claimedId = claimedId
        }

        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override prop Id string -> name

        override prop SupportsFixAll bool -> fixAll

        override func RegisterCodeFixes(context CodeFixContext) {
            if claimedId == nil {
                return
            }
            let tree = context.Tree
            let token = tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                CodeFix(
                    "opted-out",
                    "opted-out",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic),
                    claimedId!!,
                    (ct CancellationToken) -> FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(
                                tree,
                                ImmutableArray.Create(TextChange(token.Span, "nil")),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                    )
                )
            )
        }
    }

    private func Registry(provider GSharpCodeFixProvider) CodeFixService {
        let registry = CodeFixRegistry()
        registry.Add(provider)
        return CodeFixService(registry)
    }

    // Edits the trigger's tree and a companion tree.
    private class CompanionEditProvider : GSharpCodeFixProvider {
        private let companion SyntaxTree

        init(companion SyntaxTree) {
            this.companion = companion
        }

        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            let other = companion
            let tree = context.Tree
            context.RegisterFix(
                CodeFix(
                    "companion",
                    "companion",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic),
                    "test.companion",
                    (ct CancellationToken) -> FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(
                                tree,
                                ImmutableArray.Create(TextChange(token.Span, "nil")),
                                ImmutableArray[TextSpan].Empty
                            ),
                            DocumentChanges(
                                other,
                                ImmutableArray.Create(TextChange(TextSpan(0, 0), "// touched\n")),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                    )
                )
            )
        }
    }

    private class ThrowingComputeProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            context.RegisterFix(
                "throws",
                "throws",
                Applicability.MachineApplicable,
                (editor SyntaxEditor) -> {
                    throw InvalidOperationException("broken provider")
                }
            )
        }
    }

    // Declares the GS0125 of the file as a second target and fixes only the GS0273.
    private class TwoTargetProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let other = context.Compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
            let tree = context.Tree
            let token = tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                CodeFix(
                    "two",
                    "two",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic, other),
                    "test.two",
                    (ct CancellationToken) -> FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(
                                tree,
                                ImmutableArray.Create(TextChange(token.Span, "nil")),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                    )
                )
            )
        }
    }

    // Replaces `null` and the rest of the file, so any two of its fixes overlap.
    private class ToEndProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let tree = context.Tree
            let span = TextSpan.FromBounds(context.Diagnostic.Location.Span.Start, tree.Text.Length)
            context.RegisterFix(
                CodeFix(
                    "to-end",
                    "to-end",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic),
                    "test.to-end",
                    (ct CancellationToken) -> FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(
                                tree,
                                ImmutableArray.Create(TextChange(span, "nil\n")),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                    )
                )
            )
        }
    }

    // Reports TEST0231 on the package name.
    private class PackageAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor("TEST0231", DiagnosticSeverity.Warning, "package")

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) {
            context.RegisterSyntaxTreeAction(
                (c GSharp.Core.CodeAnalysis.Analyzers.SyntaxTreeAnalysisContext) -> {
                    let name = c.Tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "P")
                    c.ReportDiagnostic(Diagnostic.Create(Rule, TextLocation(c.Tree.Text, name.Span)))
                }
            )
        }
    }

    private class PackageFixProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("TEST0231")

        override func RegisterCodeFixes(context CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                "package",
                "package",
                Applicability.MachineApplicable,
                (editor SyntaxEditor) -> editor.ReplaceToken(token, "Q")
            )
        }
    }

    private func Service() CodeFixService -> CodeFixService(CodeFixRegistry.CreateDefault())

    // Replaces `null` and one character on each side, so two adjacent arguments overlap.
    private class WideNilProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let span = context.Diagnostic.Location.Span
            let text = context.Tree.Text
            let wide = TextSpan.FromBounds(span.Start - 1, span.End + 1)
            let replacement = text.ToString(TextSpan(wide.Start, 1)) + "nil" + text.ToString(TextSpan(span.End, 1))
            let tree = context.Tree
            context.RegisterFix(
                CodeFix(
                    "wide",
                    "wide",
                    Applicability.MachineApplicable,
                    ImmutableArray.Create(context.Diagnostic),
                    "test.wide",
                    (ct CancellationToken) -> FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(
                                tree,
                                ImmutableArray.Create(TextChange(wide, replacement)),
                                ImmutableArray[TextSpan].Empty
                            )
                        )
                    )
                )
            )
        }
    }
}
