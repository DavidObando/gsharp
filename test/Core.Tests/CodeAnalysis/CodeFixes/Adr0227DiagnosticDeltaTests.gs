// <copyright file="Adr0227DiagnosticDeltaTests.gs" company="GSharp">
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

/// ADR-0227 D4: the diagnostic delta of an edit over the whole compilation, the parse-only exit,
/// the named policies, the host's severity filter, and no change to the host's compilation.
open class Adr0227DiagnosticDeltaTests {
    const NullSource string = "package P\n\nfunc F() string? {\n    return null\n}\n\nfunc G() int32 {\n    return missing\n}\n"

    @Fact
    func FixThatRemovesTheTarget_IsAcceptedByEveryPolicy_AndKeepsAShiftedError() {
        let tree = SyntaxTree.Parse(SourceText.From(NullSource, "a.gs"))
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(compilation, Fix(tree, target, "null", "nil"))
        Assert.False(delta.ParseOnly)
        Assert.Same(target, Assert.Single(delta.Removed))
        Assert.Empty(delta.Added)
        let persisting = Assert.Single(delta.Persisting)
        Assert.Equal("GS0125", persisting.Id)
        Assert.True(delta.TargetRemoved)
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
        Assert.True(DeltaPolicy.RemovesTargetNoNewErrors.Accepts(delta))
        Assert.True(DeltaPolicy.NetImprovement.Accepts(delta))
        Assert.True(DeltaPolicy.PhaseAware.Accepts(delta))
    }

    @Fact
    func FixThatAddsABindError_IsRejected() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
            compilation,
            Fix(tree, target, "null", "undefinedName")
        )
        Assert.True(delta.TargetRemoved)
        Assert.Equal("GS0125", Assert.Single(delta.Added).Id)
        Assert.Equal(1, delta.Persisting.Count((d Diagnostic) -> d.Id == "GS0125"))
        Assert.False(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
        Assert.False(DeltaPolicy.RemovesTargetNoNewErrors.Accepts(delta))
        Assert.False(DeltaPolicy.PhaseAware.Accepts(delta))
        Assert.False(DeltaPolicy.NetImprovement.Accepts(delta))
    }

    @Fact
    func FixThatAddsASyntaxError_StopsAfterTheParse() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(compilation, Fix(tree, target, "null", "(nil"))
        Assert.True(delta.ParseOnly)
        Assert.NotEmpty(delta.Added)
        Assert.Equal(delta.Added.Length, delta.AddedSyntax.Length)
        Assert.False(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
    }

    @Fact
    func ParseErrorFix_ThatExposesABindError_IsAcceptedOnlyByPhaseAware() {
        const source = "package P\n\nfunc F() int32 {\n    return 1 +\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = Assert.Single(tree.Diagnostics)
        let editor = SyntaxEditor(tree)
        let plus = tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "+")
        editor.InsertAfter(plus, " undefinedName")
        let fix = CodeFix(
            "complete",
            "test",
            Applicability.MaybeIncorrect,
            ImmutableArray.Create(target),
            "test",
            (ct CancellationToken) -> FixChanges(
                ImmutableArray.Create(DocumentChanges(tree, editor.GetChanges(), ImmutableArray[TextSpan].Empty))
            )
        )
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(compilation, fix)
        Assert.True(delta.TargetsAreSyntax)
        Assert.True(delta.TargetRemoved)
        Assert.Empty(delta.AddedSyntax)
        Assert.Equal("GS0125", Assert.Single(delta.Added).Id)
        Assert.True(DeltaPolicy.PhaseAware.Accepts(delta))
        Assert.False(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
    }

    @Fact
    func DeclarationChange_ThatBreaksAnotherFile_IsAnAddedDiagnostic() {
        let a = SyntaxTree.Parse(SourceText.From("package P\n\nfunc Helper() int32 -> 1\n", "a.gs"))
        let b = SyntaxTree.Parse(SourceText.From("package P\n\nfunc User() int32 -> Helper()\n", "b.gs"))
        let compilation = Compilation(a, b)
        Assert.Empty(compilation.GetDiagnostics())
        let editor = SyntaxEditor(a)
        editor.ReplaceToken(a.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "Helper"), "Helper2")
        let changes = FixChanges(
            ImmutableArray.Create(DocumentChanges(a, editor.GetChanges(), ImmutableArray[TextSpan].Empty))
        )
        let service = CodeFixService(CodeFixRegistry())
        let delta = service.ComputeDelta(DeltaBaseline.Create(compilation), changes, ImmutableArray[Diagnostic].Empty)
        let added = Assert.Single(delta.Added)
        Assert.Equal("b.gs", added.Location.Text!!.FileName)
        Assert.False(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
    }

    @Fact
    func HostFilter_IsAppliedBeforeAndAfter() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let options = DeltaOptions()
        options.DiagnosticFilter = (d Diagnostic) -> if d.Id == "GS0125" {
            nil
        } else {
            d
        }
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
            compilation,
            Fix(tree, target, "null", "undefinedName"),
            options
        )
        Assert.Empty(delta.Added)
        Assert.Empty(delta.Persisting)
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
    }

    @Fact
    func SeverityChange_IsARemovalAndAnAddition() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let fix = Fix(tree, target, "null", "nil")
        let baseline = DeltaBaseline.Create(compilation)
        let options = DeltaOptions()
        options.DiagnosticFilter = (d Diagnostic) -> if d.Id == "GS0125" {
            d.WithSeverity(DiagnosticSeverity.Warning)
        } else {
            d
        }
        let promoted = DeltaBaseline.Create(compilation, options)
        let service = CodeFixService(CodeFixRegistry())
        Assert.Empty(service.ComputeDelta(baseline, fix).Added)
        // The baseline sees GS0125 as a warning, the check after the edit as an error.
        let mixed = service.ComputeDelta(
            DeltaBaselineWith(compilation, baseline.Options, promoted.Diagnostics),
            fix.GetChanges(),
            fix.Diagnostics
        )
        Assert.Equal("GS0125", Assert.Single(mixed.Added).Id)
        Assert.Equal(2, mixed.Removed.Length)
    }

    @Fact
    func ComputeDelta_DoesNotChangeTheHostCompilation() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let before = compilation.GetDiagnostics()
        let target = before.Single((d Diagnostic) -> d.Id == "GS0273")
        let declared = compilation.GetSemanticModel(tree).GetDeclaredSymbol(
            tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().First()
        )
        CodeFixService(CodeFixRegistry()).ComputeDelta(compilation, Fix(tree, target, "null", "nil"))
        Assert.Equal(before, compilation.GetDiagnostics())
        Assert.Same(tree, Assert.Single(compilation.SyntaxTrees))
        Assert.Same(
            declared,
            compilation.GetSemanticModel(tree).GetDeclaredSymbol(
                tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().First()
            )
        )
    }

    @Fact
    func CancelledRequest_Throws() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let baseline = DeltaBaseline.Create(compilation)
        let source = CancellationTokenSource()
        source.Cancel()
        Assert.ThrowsAny[OperationCanceledException](
            () -> CodeFixService(CodeFixRegistry()).ComputeDelta(
                baseline,
                Fix(tree, target, "null", "nil"),
                source.Token
            )
        )
    }

    @Fact
    func WithReplacedSyntaxTrees_RejectsUnknownAndRepeatedTrees() {
        let a = SyntaxTree.Parse("package P\n")
        let compilation = Compilation(a)
        let other = SyntaxTree.Parse("package Q\n")
        Assert.Throws[ArgumentException](
            () -> compilation.WithReplacedSyntaxTrees(ImmutableArray.Create(other), ImmutableArray.Create(other))
        )
        Assert.Throws[ArgumentException](
            () -> compilation.WithReplacedSyntaxTrees(ImmutableArray.Create(a, a), ImmutableArray.Create(other, other))
        )
        Assert.Throws[ArgumentException](
            () -> compilation.WithReplacedSyntaxTrees(ImmutableArray.Create(a), ImmutableArray[SyntaxTree].Empty)
        )
        let replaced = compilation.WithReplacedSyntaxTrees(ImmutableArray.Create(a), ImmutableArray.Create(other))
        Assert.Same(other, Assert.Single(replaced.SyntaxTrees))
        Assert.Same(a, Assert.Single(compilation.SyntaxTrees))
    }

    private func DeltaBaselineWith(
        compilation Compilation,
        options DeltaOptions,
        diagnostics ImmutableArray[Diagnostic]
    ) DeltaBaseline -> DeltaBaseline.CreateForTest(compilation, options, diagnostics)

    private func Fix(tree SyntaxTree, target Diagnostic, oldText string, newText string) CodeFix {
        let editor = SyntaxEditor(tree)
        editor.ReplaceToken(tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == oldText), newText)
        let changes = editor.GetChanges()
        return CodeFix(
            "test",
            "test",
            Applicability.MachineApplicable,
            ImmutableArray.Create(target),
            "test",
            (ct CancellationToken) -> FixChanges(
                ImmutableArray.Create(DocumentChanges(tree, changes, ImmutableArray[TextSpan].Empty))
            )
        )
    }
}
