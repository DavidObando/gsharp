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
            DeltaBaselineWith(compilation, baseline.EffectiveOptions, promoted.Diagnostics),
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
    func CancelledRequest_ThrowsOnTheParseOnlyPathToo() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let baseline = DeltaBaseline.Create(compilation)
        let fix = Fix(tree, target, "null", "(nil")
        fix.GetChanges()
        let source = CancellationTokenSource()
        source.Cancel()
        Assert.ThrowsAny[OperationCanceledException](
            () -> CodeFixService(CodeFixRegistry()).ComputeDelta(baseline, fix, source.Token)
        )
    }

    @Fact
    func TreesThatShareASourceText_AreRejected() {
        let text = SourceText.From("package P\n\nfunc F() string? -> null\n", "a.gs")
        let first = SyntaxTree.Parse(text)
        let second = SyntaxTree.Parse(text)
        let compilation = Compilation(first, second)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0273")
        Assert.Throws[ArgumentException](
            () -> CodeFixService(CodeFixRegistry()).ComputeDelta(compilation, Fix(first, target, "null", "nil"))
        )
    }

    @Fact
    func ParserWarningTarget_IsNotRelaxedByPhaseAware() {
        const source = "package P\n\nfunc F(n int32) string {\n    return switch n {\n        case 0 -> \"zero\"\n        default: \"other\"\n    }\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0302")
        Assert.False(target.IsError)
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
            compilation,
            Fix(tree, target, "->", ": undefinedName +")
        )
        Assert.False(delta.TargetsAreSyntax)
        Assert.NotEmpty(delta.Added)
        Assert.False(DeltaPolicy.PhaseAware.Accepts(delta))
    }

    @Fact
    func ParseStage_AppliesSourceSuppressions() {
        const source = "package P\n\n@SuppressDiagnostic(\"GS0302\")\nfunc F(n int32) string {\n    return switch n {\n        case 0: \"zero\"\n        default: \"other\"\n    }\n}\n\nfunc G() string? -> null\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let editor = SyntaxEditor(tree)
        editor.ReplaceToken(tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "null"), "nil")
        editor.ReplaceToken(tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == ":"), " ->")
        let changes = FixChanges(
            ImmutableArray.Create(DocumentChanges(tree, editor.GetChanges(), ImmutableArray[TextSpan].Empty))
        )
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
            DeltaBaseline.Create(compilation),
            changes,
            ImmutableArray.Create(target)
        )
        Assert.False(delta.ParseOnly)
        Assert.Empty(delta.Added)
        Assert.True(delta.TargetRemoved)
    }

    @Fact
    func TargetRemoved_ComparesContent_NotIdentity() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let options = DeltaOptions()
        // A filter that always returns copies: the removed diagnostic is not the target object.
        options.DiagnosticFilter = (d Diagnostic) -> d.WithSeverity(DiagnosticSeverity.Warning).WithSeverity(
            DiagnosticSeverity.Error
        )
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
            compilation,
            Fix(tree, target, "null", "nil"),
            options
        )
        Assert.True(delta.TargetRemoved)
        Assert.True(DeltaPolicy.RemovesTargetNoNewErrors.Accepts(delta))
    }

    @Fact
    func Baseline_KeepsItsOptions_WhenTheCallerChangesThem() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let options = DeltaOptions()
        options.DiagnosticFilter = (d Diagnostic) -> if d.Id == "GS0125" {
            nil
        } else {
            d
        }
        let baseline = DeltaBaseline.Create(compilation, options)
        options.DiagnosticFilter = nil
        baseline.Options.DiagnosticFilter = nil
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(baseline, Fix(tree, target, "null", "nil"))
        Assert.Empty(delta.Added)
    }

    @Fact
    func ParseOnlyDelta_IsAcceptedByNoPolicy() {
        const source = "package P\n\nfunc F(n int32) string {\n    return 1 +\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = Assert.Single(tree.Diagnostics)
        let editor = SyntaxEditor(tree)
        editor.InsertAfter(
            tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "+"),
            " undefinedName\n        let s = switch n {\n            case 0 -> 1\n            default: 2\n        }"
        )
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
        Assert.True(delta.ParseOnly)
        Assert.True(delta.Added.All((d Diagnostic) -> !d.IsError))
        Assert.False(DeltaPolicy.RemovesTargetNoNewErrors.Accepts(delta))
        Assert.False(DeltaPolicy.NetImprovement.Accepts(delta))
        Assert.False(DeltaPolicy.PhaseAware.Accepts(delta))
    }

    @Fact
    func TwoEquivalentTargets_NeedTwoRemovals() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let fix = Fix(tree, target, "null", "nil")
        let twice = service().ComputeDelta(
            DeltaBaseline.Create(compilation),
            fix.GetChanges(),
            ImmutableArray.Create(target, target)
        )
        Assert.False(twice.TargetRemoved)
    }

    @Fact
    func RepeatedDiagnosticReference_CountsAsTwoOccurrences() {
        let tree = SyntaxTree.Parse(NullSource)
        let compilation = Compilation(tree)
        let missing = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0125")
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let options = DeltaOptions()
        options.Analyzers = ImmutableArray.Create[GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer](
            DoubleReportAnalyzer()
        )
        let before = DeltaBaseline.Create(compilation, options)
        // One report before the edit (the analyzer is quiet while `null` is there), two after.
        let delta = service().ComputeDelta(
            before,
            Fix(tree, target, "null", "nil").GetChanges(),
            ImmutableArray.Create(target)
        )
        Assert.Equal(1, delta.Added.Count((d Diagnostic) -> d.Id == "TEST0227"))
        Assert.False(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
        Assert.NotNull(missing)
    }

    @Fact
    func EditAtTheBoundaryOfAReport_KeepsItPersisting() {
        const source = "package P\n\nfunc F() string? {\n    let foo = 1\n    return null\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0273")
        let options = DeltaOptions()
        options.Analyzers = ImmutableArray.Create[GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer](
            FixedMessageAnalyzer(true),
            FixedMessageAnalyzer(false)
        )
        let editor = SyntaxEditor(tree)
        editor.ReplaceToken(tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "null"), "nil")
        // `foo` becomes `foox`, and a newline goes before the report at position 0.
        editor.InsertAfter(tree.Root.DescendantTokens().First((t SyntaxToken) -> t.Text == "foo"), "x")
        editor.InsertBefore(tree.Root.GetFirstToken(), "\n")
        let changes = FixChanges(
            ImmutableArray.Create(DocumentChanges(tree, editor.GetChanges(), ImmutableArray[TextSpan].Empty))
        )
        let delta = service().ComputeDelta(
            DeltaBaseline.Create(compilation, options),
            changes,
            ImmutableArray.Create(target)
        )
        Assert.Empty(delta.Added)
        Assert.Equal(2, delta.Persisting.Count((d Diagnostic) -> d.Id == "TEST0228"))
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
    }

    @Fact
    func Baseline_CopiesTheAnalyzerOptions() {
        let compilation = Compilation(SyntaxTree.Parse(NullSource))
        let options = DeltaOptions()
        options.AnalyzerOptions = GSharp.Core.CodeAnalysis.Analyzers.AnalyzerOptions{TimeBudgetMilliseconds: 100}
        let baseline = DeltaBaseline.Create(compilation, options)
        options.AnalyzerOptions!!.TimeBudgetMilliseconds = 5
        baseline.Options.AnalyzerOptions!!.TimeBudgetMilliseconds = 7
        Assert.Equal(100, baseline.EffectiveOptions.AnalyzerOptions!!.TimeBudgetMilliseconds)
    }

    private func service() CodeFixService -> CodeFixService(CodeFixRegistry())

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

    // Reports one diagnostic at the start of the file: once while the file has `null`, else the same
    // object twice.
    private class DoubleReportAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor("TEST0227", DiagnosticSeverity.Warning, "probe")

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) {
            context.RegisterSyntaxTreeAction(
                (c GSharp.Core.CodeAnalysis.Analyzers.SyntaxTreeAnalysisContext) -> {
                    let d = Diagnostic.Create(Rule, TextLocation(c.Tree.Text, TextSpan(0, 7)))
                    c.ReportDiagnostic(d)
                    if !c.Tree.Text.ToString().Contains("null") {
                        c.ReportDiagnostic(d)
                    }
                }
            )
        }
    }

    // Reports a fixed message on the first identifier that starts with `foo`, or at position 0.
    private class FixedMessageAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor("TEST0228", DiagnosticSeverity.Warning, "fixed")
        private let onFoo bool

        init(onFoo bool) {
            this.onFoo = onFoo
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) {
            context.RegisterSyntaxTreeAction(
                (c GSharp.Core.CodeAnalysis.Analyzers.SyntaxTreeAnalysisContext) -> {
                    var span = TextSpan(0, 0)
                    if onFoo {
                        let token = c
                            .Tree
                            .Root
                            .DescendantTokens()
                            .First((t SyntaxToken) -> t.Text.StartsWith("foo", StringComparison.Ordinal))
                        span = token.Span
                    }
                    c.ReportDiagnostic(Diagnostic.Create(Rule, TextLocation(c.Tree.Text, span)))
                }
            )
        }
    }
}
