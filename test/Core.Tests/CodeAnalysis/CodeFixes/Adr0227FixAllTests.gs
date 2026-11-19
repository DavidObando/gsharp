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
