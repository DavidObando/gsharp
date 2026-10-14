// <copyright file="Issue4173NullConditionalAnalyzerMappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import Microsoft.CodeAnalysis.Diagnostics
import Xunit
import RoslynDiagnosticAnalyzer = Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis

/// Issue #4173: cs2gs's ADR-0169 analyzer-translation mode had no idiom for
/// C#'s null-conditional-access syntax (`ConditionalAccessExpressionSyntax`
/// / `MemberBindingExpressionSyntax`). G# represents `a?.b` as the
/// SAME node as `a.b` (`AccessorExpressionSyntax`) with a boolean
/// `IsNullConditional` flag rather than a distinct kind, so a naive
/// type/kind map-row extension (the pattern that fixed this file's other
/// analyzer-API gaps) would have silently matched every ordinary member
/// access — this is fixed as an idiom-level rewrite in
/// `CSharpToGSharpTranslator.Analyzers.cs` instead:
/// - `expr is ConditionalAccessExpressionSyntax x` →
/// `expr is AccessorExpressionSyntax { IsNullConditional: true } x`.
/// - `RegisterSyntaxNodeAction(handler, SyntaxKind.ConditionalAccessExpression)` → a guarded wrapper
/// lambda registered for `SyntaxKind.AccessorExpression`.
/// `MemberBindingExpressionSyntax`/`ElementBindingExpressionSyntax`
/// (including `x.WhenNotNull is MemberBindingExpressionSyntax`, a
/// companion test some analyzers use to try to prove a single-hop access)
/// deliberately stay unmapped — a direct reference is a loud gap, not a bug.
/// A per-node type/kind test cannot actually distinguish "this is the last
/// hop of its chain" in Roslyn's tree shape from "this is not": a REAL Roslyn
/// tree for `a?.b?.c` contains an INNER `ConditionalAccessExpressionSyntax`
/// node (`Expression: MemberBindingExpressionSyntax(.b)`,
/// `WhenNotNull: MemberBindingExpressionSyntax(.c)`) whose own
/// `WhenNotNull` IS a bare `MemberBindingExpressionSyntax` — so the
/// conjunction is provably true on a genuine two-level chain, not only on a
/// true single-hop `a?.b`. A translator-side rewrite of that conjunction
/// to a per-G#-node `IsNullConditional` check therefore cannot preserve
/// Roslyn's semantics: it was empirically confirmed to over-fire (2 reports
/// instead of Roslyn's 1 for a chain, 1 instead of 0 for `a?.b.c`), the
/// same silent-over-match failure class the issue's own investigation warned
/// a naive map-row extension would cause. So the safe behavior — matching the
/// already-unmapped `AssignmentExpressionSyntax.Left` — is a loud
/// `CS2GS-GAP` on any surviving `.WhenNotNull`/`.Expression`
/// read, single-hop-proving conjunction or not.
///
/// Every assertion that can execute a real analyzer does: the analyzer source
/// is translated by the real (cref:CSharpToGSharpTranslator), compiled
/// by the real G# compiler, loaded, and run through the real
/// (cref:GSharpAnalyzerVerifier) over real G# source — the same
/// methodology `Issue3920Gsa0002ImportedOperandDispatchTests` uses.
class Issue4173NullConditionalAnalyzerMappingTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-issue4173-null-conditional")

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    /// Positive/negative parity, executed end to end: the translated analyzer
    /// fires on every null-conditional access (single-hop AND the two levels
    /// of a chain) and stays silent on an ordinary access — proving the
    /// property-pattern rewrite discriminates the flag rather than the naive
    /// kind-rename's constant match on every access.
    /// @param gsSource The G# source under test, with markers.
    /// @param ids The expected diagnostic ids, one per marker.
    @Theory
    @MemberData("ParityCases")
    func TranslatedAnalyzer_FiresOnNullConditionalAccess_NotOnOrdinaryAccess(gsSource string, ids[]string) {
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            NullConditionalAnalyzerSource,
            "TranslatedIssue4173"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, gsSource, ids)
    }

    /// Chain positive: `a?.b?.c` parses left-associatively into TWO
    /// nested `AccessorExpressionSyntax` nodes, each carrying its own
    /// `IsNullConditional` — both must fire, proving the property-pattern
    /// rewrite (and the registration guard) is chain-safe. Both nodes share
    /// the same leftmost source position (left-recursive nesting), which the
    /// marker-based (cref:GSharpAnalyzerVerifier) cannot disambiguate,
    /// so this drives (cref:GSharpAnalyzerDriver) directly and asserts
    /// the diagnostic COUNT instead.
    @Fact
    func ChainCase_BothNullConditionalLevelsReported() {
        const GsSource = `package sample

class Leaf(Value string) { }

class Box(Next Box?, Leaf Leaf?) { }

func Get(box Box?) Leaf?
{
    return box?.Next?.Leaf
}`
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            NullConditionalAnalyzerSource,
            "TranslatedIssue4173Chain"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(GsSource, "chain.gs"))
        Assert.True(
            tree.Diagnostics.IsEmpty,
            string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))
        )
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(tree)
        Assert.True(
            compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .All((d GSharp.Core.CodeAnalysis.Diagnostic) -> !d.IsError),
            "chain.gs should bind"
        )
        let diagnostics = GSharpAnalyzerDriver.Run(compilation, ImmutableArray.Create(analyzer))
        Assert.Equal(2, diagnostics.Length)
        Assert.All(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> Assert.Equal("TEST4173", d.Id))
        // Both null-conditional levels (`box?.Next` and `(box?.Next)?.Leaf`)
        // must be distinct nodes reported, not the same node twice.
        Assert.Equal(
            2,
            diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Location.Span).Distinct().Count()
        )
    }

    /// The `is ConditionalAccessExpressionSyntax x` idiom in isolation:
    /// the printed G# carries the property-pattern rewrite, not a bare
    /// (over-matching) kind rename, and it binds against the real G# compiler.
    @Fact
    func TypeTest_TranslatesToPropertyPatternAndBinds() {
        let (printed, diagnostics) = TranslateAnalyzerSource(NullConditionalAnalyzerSource)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.Contains("ExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ConditionalAccessExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
    }

    /// Row 3 / row 5 (issue #4173's critical parity checks): the tail-test
    /// idiom fires exactly once on a genuine `a?.b?.c` chain (row 3 —
    /// the removed idiom's over-fire repro, which reported 2) and exactly
    /// zero times on `a?.b.c` (row 5 — the removed idiom's second
    /// counterexample, which reported 1), matching Roslyn exactly on both.
    @Fact
    func TailMemberBindingTest_MatchesRoslyn_OnChainAndMixedInputs() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            TailMemberBindingAnalyzerSource,
            "TailMemberBindingAnalyzer"
        )
        let roslynChainIds = RunRoslynAnalyzer(roslynAnalyzer, TailMemberBindingChainCorpus, "TEST4173B")
        let roslynMixedIds = RunRoslynAnalyzer(roslynAnalyzer, TailMemberBindingMixedCorpus, "TEST4173B")
        Assert.Equal([]string{"TEST4173B"}, roslynChainIds) // Row 3: Roslyn fires exactly once.
        Assert.Empty(roslynMixedIds) // Row 5: Roslyn fires zero times.
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            TailMemberBindingAnalyzerSource,
            "TranslatedTailMemberBinding"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const ChainGsSource = `package sample

class Leaf(Value string) { }
class Box(Next Box?, Leaf Leaf?) { }

func Chain(box Box?) Leaf?
{
    return box?.Next?.Leaf
}`
        const MixedGsSource = `package sample

class Leaf(Value string) { }
class Mid(Leaf Leaf, Next Mid) { }
class Root(Mid Mid) { }

func Mixed(root Root?) Leaf?
{
    return root?.Mid.Leaf
}`
        let chainDiagnostics = RunGsAnalyzer(analyzerDll, ChainGsSource)
        let mixedDiagnostics = RunGsAnalyzer(analyzerDll, MixedGsSource)
        Assert.Equal(roslynChainIds.Count, chainDiagnostics.Length) // Row 3: G# also fires exactly once, not twice.
        Assert.Equal(roslynMixedIds.Count, mixedDiagnostics.Length) // Row 5: G# also fires zero times, not once.

    }

    /// A three-level chain `a?.b?.c?.d` has two operators whose
    /// `WhenNotNull` is itself another `ConditionalAccessExpressionSyntax`
    /// (every operator except the last) — Roslyn fires twice, and the
    /// translated analyzer (via `NullConditionalChain.NextNullConditionalHop`)
    /// must match exactly, proving the recursive-chain-walk idiom (I4's third
    /// case) is chain-safe rather than merely single-hop-safe.
    @Fact
    func RecursiveChainWalkTest_MatchesRoslyn_OnThreeLevelChain() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            RecursiveChainWalkAnalyzerSource,
            "RecursiveChainWalkAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, RecursiveChainWalkCorpus, "TEST4173D")
        Assert.Equal([]string{"TEST4173D", "TEST4173D"}, roslynIds)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            RecursiveChainWalkAnalyzerSource,
            "TranslatedRecursiveChainWalk"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Leaf(Value string) { }
class Box(Next Box?, Leaf Leaf?) { }

func Chain(box Box?) Leaf?
{
    return box?.Next?.Next?.Leaf
}`
        let diagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Equal(roslynIds.Count, diagnostics.Length)
        Assert.Equal(
            2,
            diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Location.Span).Distinct().Count()
        )
    }

    /// `.WhenNotNull` read into a LOCAL (not tested by an `is`
    /// pattern I4 can intercept) has no G# counterpart and correctly has
    /// none — same category as the already-unmapped
    /// `AssignmentExpressionSyntax.Left`. Must surface a loud
    /// CS2GS-GAP at translate time, never a silent wrong answer.
    @Fact
    func BareWhenNotNullValueRead_IsALoudGap() {
        let (printed, diagnostics) = TranslateAnalyzerSource(BareWhenNotNullValueAnalyzerSource)
        // The falsifier: `.WhenNotNull` really did survive untranslated (it
        // was not silently dropped or renamed), so the bind failure below is
        // a real one, not a vacuous pass.
        Assert.Contains(".WhenNotNull", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        let errors = TryGetBindErrors(printed)
        Assert.NotEmpty(errors)
        Assert.Contains(errors, (e string) -> e.Contains("WhenNotNull", StringComparison.Ordinal))
    }

    /// A multi-kind registration naming `ConditionalAccessExpression`
    /// alongside another kind is a loud gap: the wrapper guard the single-kind
    /// case uses would incorrectly also reject the other kind's dispatch.
    @Fact
    func MultiKindRegistration_IsALoudGapRatherThanAWrongGuard() {
        let (_, diagnostics) = TranslateAnalyzerSource(MultiKindRegistrationAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("RegisterSyntaxNodeAction", gap.Message, StringComparison.Ordinal)
    }

    /// The bare (undesignated) type-test form — parsed as
    /// `BinaryExpressionSyntax`/`SyntaxKind.IsExpression`, not a
    /// pattern — must translate through the SAME `AsNullConditionalHop`
    /// rewrite as the designated form, never falling back to I7's bare
    /// non-discriminating `ExpressionSyntax` supertype (which would make
    /// this fire on every access, not just null-conditional ones).
    @Fact
    func BareCastHandlerTypeTest_TranslatesToAsNullConditionalHop_NotVacuousExpressionSyntax() {
        let (printed, diagnostics) = TranslateAnalyzerSource(BareCastHandlerAnalyzerSource)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            BareCastHandlerAnalyzerSource,
            "TranslatedBareCastHandler"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return [|box?.Name|]
}`, []string{"TEST4173H"})
        // The falsifier: an ORDINARY access must NOT fire (the I7-vacuous-truth repro).
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`, Array.Empty[string]())
    }

    /// I5's declined `.Expression is ConditionalAccessExpressionSyntax`
    /// case, undesignated: must surface the SAME `CS2GS-GAP` as the
    /// designated form, never a silently vacuous `NullConditionalReceiver(x)
    /// is ExpressionSyntax` (always true).
    @Fact
    func BareReceiverConditionalAccessTest_IsALoudGap() {
        let (_, diagnostics) = TranslateAnalyzerSource(BareReceiverConditionalAccessAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("ConditionalAccessExpressionSyntax", gap.Message, StringComparison.Ordinal)
    }

    /// The sibling bug's fix, verified against real Roslyn: `a?.b.c`
    /// fires exactly once (the ordinary `.c` access), matching Roslyn's
    /// own `MemberAccessExpressionSyntax` count exactly — not twice, the
    /// pre-fix over-fire (both the `?.b` hop and the ordinary `.c`
    /// access, since the unconditional map row could not tell them apart).
    @Fact
    func OrdinaryMemberAccessTest_MatchesRoslyn_OnMixedChain() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            OrdinaryMemberAccessAnalyzerSource,
            "OrdinaryMemberAccessAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, OrdinaryMemberAccessCorpus, "TEST4173J")
        Assert.Equal([]string{"TEST4173J"}, roslynIds) // Row 15: Roslyn fires exactly once, not twice.
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            OrdinaryMemberAccessAnalyzerSource,
            "TranslatedOrdinaryMemberAccess"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Leaf(Value string) { }
class Mid(Leaf Leaf, Next Mid) { }
class Root(Mid Mid) { }

func Mixed(root Root?) Leaf?
{
    return root?.Mid.Leaf
}`
        let diagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Equal(roslynIds.Count, diagnostics.Length)
    }

    /// With NO inner type test, only the REGISTRATION'S own guard can keep a
    /// `?.` hop out of the handler — proving I2's `SimpleMemberAccessExpression`
    /// guard is load-bearing on its own, not merely redundant with I1b's
    /// handler-level fix.
    @Fact
    func BareOrdinaryRegistration_FiresOnlyOnOrdinaryAccess() {
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            BareOrdinaryRegistrationAnalyzerSource,
            "TranslatedBareOrdinaryRegistration"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return [|box.Name|]
}`, []string{"TEST4173K"})
        // The falsifier: a null-conditional access must NOT reach the handler.
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.Name
}`, Array.Empty[string]())
    }

    /// I3/I3a composed: for the FIRST (only) hop of a single-level chain, the
    /// Roslyn-exact receiver span is the receiver's own natural span (no
    /// truncation needed — nothing precedes it), so the reported location
    /// lands exactly on `box`, matching Roslyn's own
    /// `ConditionalAccessExpressionSyntax.Expression.GetLocation()`.
    @Fact
    func ReceiverLocationTest_TranslatesAndBindsAndFiresAtReceiver() {
        let (printed, diagnostics) = TranslateAnalyzerSource(ReceiverLocationAnalyzerSource)
        Assert.Contains("NullConditionalChain.ReceiverSpan", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReceiverLocationAnalyzerSource,
            "TranslatedReceiverLocation"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return [|box|]?.Name
}`, []string{"TEST4173C"})
    }

    /// I5's `ReceiverIsMemberBinding` case, verified against real
    /// Roslyn: fires exactly once on `a?.b?.c` (the inner `?.c`
    /// hop, whose receiver continues directly off the outer `?.b` with
    /// no ordinary step in between), not on the outer hop.
    @Fact
    func InnerHopReceiverTest_MatchesRoslyn_OnChain() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            InnerHopReceiverTestAnalyzerSource,
            "InnerHopReceiverTestAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, InnerHopReceiverTestCorpus, "TEST4173F")
        Assert.Equal([]string{"TEST4173F"}, roslynIds)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            InnerHopReceiverTestAnalyzerSource,
            "TranslatedInnerHopReceiverTest"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Leaf(Value string) { }
class Box(Next Box?, Leaf Leaf?) { }

func Chain(box Box?) Leaf?
{
    return box?.Next?.Leaf
}`
        let diagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Equal(roslynIds.Count, diagnostics.Length)
    }

    /// I6's declarative `MemberBindingExpressionSyntax.Name -> RightPart`
    /// row, composed with I4's designator binding: translates and binds
    /// cleanly, and fires once on a single-hop `a?.b`.
    @Fact
    func NameExtractionTest_TranslatesAndBindsAndFires() {
        let (printed, diagnostics) = TranslateAnalyzerSource(NameExtractionAnalyzerSource)
        Assert.Contains("RightPart", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            NameExtractionAnalyzerSource,
            "TranslatedNameExtraction"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.[|Name|]
}`, []string{"TEST4173G"})
    }

    /// I8's `OfType<ConditionalAccessExpressionSyntax>()` rewrite:
    /// a two-level chain has exactly two hops, and the walk must find
    /// exactly those two — not zero (an unmapped `OfType` would be a
    /// loud gap instead) and not every ordinary access (I7's supertype risk
    /// if I8 did not re-narrow explicitly).
    @Fact
    func DescendantWalkTest_FindsExactlyTheChainHops() {
        let (printed, diagnostics) = TranslateAnalyzerSource(DescendantWalkAnalyzerSource)
        Assert.Contains("NullConditionalChain.IsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            DescendantWalkAnalyzerSource,
            "TranslatedDescendantWalk"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Leaf(Value string) { }
class Box(Next Box?, Leaf Leaf?) { }

func Chain(box Box?) Leaf?
{
    return box?.Next?.Leaf
}

func Plain(box Box) Box
{
    return box.Next!!
}`
        let gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Equal(2, gsDiagnostics.Length)
        Assert.Equal(
            2,
            gsDiagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Location.Span).Distinct().Count()
        )
    }

    /// The round-2 reviewer's exact counterexample, verified against BOTH
    /// real Roslyn and the translated analyzer: plain (non-null-conditional)
    /// member access must yield ZERO diagnostics, not the pre-round-3 over-
    /// match of 2. Also asserts the printed G# carries the sound
    /// `AsNullConditionalHop` predicate rewrite, never a bare (and
    /// therefore vacuously-true-on-anything) `is not ExpressionSyntax`.
    @Fact
    func ReviewerCounterexample_NegatedDesignatedConditionalAccess_MatchesRoslyn_OnPlainAccess() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            Round3NotDesignatedAnalyzerSource,
            "Round3NotDesignatedAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TEST4173R3A")
        Assert.Empty(roslynIds) // Real Roslyn: zero. The pre-round-3 bug reported 2 here.
        let (printed, diagnostics) = TranslateAnalyzerSource(Round3NotDesignatedAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("is not ExpressionSyntax", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            Round3NotDesignatedAnalyzerSource,
            "TranslatedRound3NotDesignated"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`
        let gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Empty(gsDiagnostics) // G#: zero, matching Roslyn.

    }

    /// Positive counterpart of
    /// (cref:ReviewerCounterexample_NegatedDesignatedConditionalAccess_MatchesRoslyn_OnPlainAccess):
    /// translates soundly and binds — the key risk this test targets is the
    /// STATEMENT-form positive designated pattern being claimed by the
    /// `if let`/positive-guard-hoist machinery (which used to reach
    /// MapTypeSyntax directly) before TranslateIsPattern's own analyzer-idiom
    /// entry point runs. Also verified against real Roslyn on the null-
    /// conditional corpus (zero-vs-nonzero — not an exact execution-count
    /// comparison: G# dispatches its folded member-access NAME token to the
    /// same registration as its receiver, an orthogonal representational
    /// difference unrelated to this fix, same as
    /// (cref:OrCombinatorConditionalAccess_TranslatesBothLeavesSoundly)'s note).
    @Fact
    func PositiveDesignatedConditionalAccess_MatchesRoslyn_OnBothShapes() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            Round3PositiveDesignatedAnalyzerSource,
            "Round3PositiveDesignatedAnalyzer"
        )
        let roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer,
            Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"),
            "TEST4173R3I"
        )
        let roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TEST4173R3I")
        Assert.Single(roslynConditionalIds)
        Assert.Empty(roslynPlainIds)
        let (printed, diagnostics) = TranslateAnalyzerSource(Round3PositiveDesignatedAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            Round3PositiveDesignatedAnalyzerSource,
            "TranslatedRound3PositiveDesignated"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        let conditionalDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.Name
}`)
        let plainDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`)
        Assert.NotEmpty(conditionalDiagnostics) // Fires on the null-conditional access (like Roslyn).
        Assert.Empty(plainDiagnostics) // Stays silent on plain access (like Roslyn) — the over-match this round fixes.

    }

    /// A bare (undesignated) `or` combinator over two shared-node types
    /// (CAE and MemberAccessExpressionSyntax) — proves
    /// `PatternMentionsConditionalAccessType`'s refusal in
    /// `IsNativelyExpressiblePattern` correctly diverts the WHOLE pattern
    /// (not just the CAE leaf) to boolean lowering, and that lowering's
    /// existing `||` composition needs no CAE-specific code at all — both
    /// leaves get their own discriminator/predicate rewrite exactly as if
    /// each stood alone. (A full Roslyn-vs-G# execution parity check is not
    /// meaningful here: G# folds a member-access NAME token onto the SAME
    /// right-nested node its receiver hop does, so `.Parent`-based
    /// traversal counts do not correspond 1:1 with Roslyn's
    /// `MemberBindingExpressionSyntax`-vs-`IdentifierNameSyntax`
    /// split — an orthogonal representational difference, not a soundness
    /// gap in this fix. Translation soundness is what §4.2 promises here.)
    @Fact
    func OrCombinatorConditionalAccess_TranslatesBothLeavesSoundly() {
        let (printed, diagnostics) = TranslateAnalyzerSource(Round3OrCombinatorAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.Contains("AccessorExpressionSyntax { IsNullConditional: false }", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            Round3OrCombinatorAnalyzerSource,
            "TranslatedRound3OrCombinator"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        Assert.Single(analyzers)
    }

    /// A designator under the `and` combinator — the one non-top-level
    /// position C#/G# both allow one (GS0390) — must bind and the second
    /// conjunct must still evaluate (here always true, so this behaves
    /// identically to the bare designated form, but exercises the `and`
    /// composition path instead of the top-level I1 shortcut).
    @Fact
    func AndCombinatorConditionalAccess_MatchesRoslyn_OnMixedAccess() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            Round3AndCombinatorAnalyzerSource,
            "Round3AndCombinatorAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, OrdinaryMemberAccessCorpus, "TEST4173R3C")
        let (printed, diagnostics) = TranslateAnalyzerSource(Round3AndCombinatorAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            Round3AndCombinatorAnalyzerSource,
            "TranslatedRound3AndCombinator"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Leaf(Value string) { }
class Mid(Leaf Leaf, Next Mid) { }
class Root(Mid Mid) { }

func Mixed(root Root?) Leaf?
{
    return root?.Mid.Leaf
}`
        let gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Equal(roslynIds.Count, gsDiagnostics.Length)
    }

    /// §4.3: a switch-case label is a GPattern-only position — CAE's faithful
    /// G# form is a predicate, not a node type, so this MUST surface a loud
    /// `CS2GS-GAP`, never a silent (and unsound) fallback.
    @Fact
    func SwitchLabelConditionalAccess_IsALoudGap() {
        let (_, diagnostics) = TranslateAnalyzerSource(Round3SwitchLabelAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId)
        Assert.Contains("ConditionalAccessExpressionSyntax", gap.Message, StringComparison.Ordinal)
    }

    /// §4.3's switch-EXPRESSION-arm sibling of (cref:SwitchLabelConditionalAccess_IsALoudGap).
    @Fact
    func SwitchExpressionArmConditionalAccess_IsALoudGap() {
        let (_, diagnostics) = TranslateAnalyzerSource(Round3SwitchExpressionArmAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId)
        Assert.Contains("ConditionalAccessExpressionSyntax", gap.Message, StringComparison.Ordinal)
    }

    /// §4.2(c), the critical CAN'T-SKIP case: a nested property subpattern
    /// (`ParenthesizedExpressionSyntax { Expression: ConditionalAccessExpressionSyntax
    /// cae }`) reaches the leaf hook through `AddTypedSubpatternTest`,
    /// which calls `TranslatePatternTest` WITHOUT a `receiverSyntax`
    /// (it defaults to null). If the CAE hook were gated on
    /// `receiverSyntax != null`, this shape would silently mishandle —
    /// reintroducing the exact bug class round 3 fixes. This must translate
    /// without throwing, bind, and match real Roslyn on a genuine
    /// parenthesized chain-break corpus.
    @Fact
    func NestedSubpatternConditionalAccess_MatchesRoslyn_WithNullReceiverSyntax() {
        const Corpus = `
public class Box { public Box? Next; public string? Value; }
public class Corpus { public static string? Get(Box? a) => (a?.Next)?.Value; }
`
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            Round3NestedSubpatternAnalyzerSource,
            "Round3NestedSubpatternAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, Corpus, "TEST4173R3F")
        Assert.Single(roslynIds) // The one parenthesized chain-break: (a?.Next).
        let (printed, diagnostics) = TranslateAnalyzerSource(Round3NestedSubpatternAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        AssertBinds(printed)
    }

    /// The ElementAccessExpressionSyntax sibling of the tier-1 switch-label
    /// bug (row 15's MemberAccessExpressionSyntax case, here as a genuine
    /// switch-case label instead of an is-pattern). Roslyn NEVER sees
    /// `box?[0]` as `ElementAccessExpressionSyntax` at all (it is
    /// `ElementBindingExpressionSyntax`, a different kind), so real
    /// Roslyn's own count is 1 (only `box[0]`) no matter how the
    /// analyzer is written — but G# folds BOTH onto the SAME
    /// `IndexExpressionSyntax` node, distinguished only by
    /// `IsNullConditional`. Without the round-3 discriminator, the
    /// translated switch-case label would over-match to 2; the fix keeps it
    /// at 1, matching Roslyn.
    @Fact
    func SwitchLabelElementAccess_MatchesRoslyn_OnMixedAccess() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            Round3ElementAccessSwitchLabelAnalyzerSource,
            "Round3ElementAccessSwitchLabelAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, Round3ElementAccessSwitchLabelCorpus, "TEST4173R3G")
        Assert.Single(roslynIds) // Only box[0]; box?[0] is ElementBindingExpressionSyntax to Roslyn.
        let (printed, diagnostics) = TranslateAnalyzerSource(Round3ElementAccessSwitchLabelAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("IndexExpressionSyntax { IsNullConditional: false }", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            Round3ElementAccessSwitchLabelAnalyzerSource,
            "TranslatedRound3ElementAccessSwitchLabel"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        const GsSource = `package sample

class Box {
    prop this[i int32] string -> ""
}

func Plain(box Box) string
{
    return box[0]
}

func Conditional(box Box?) string?
{
    return box?[0]
}`
        let gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource)
        Assert.Equal(
            roslynIds.Count,
            gsDiagnostics.Length
        ) // G# also fires exactly once, not twice (the pre-fix over-match).

    }

    /// Regression for the "preserved ordering" concern: none of the tier-1
    /// leaf swaps disturb `TryTranslateAnalyzerBaseCallCheck`, which must
    /// still run FIRST (it is called at the head of `TranslateIsPattern`,
    /// before any generic pattern translation).
    @Fact
    func BaseCallCheck_StillTranslatesToBaseClassCallExpressionSyntax() {
        const AnalyzerSource = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BaseCallCheckAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3H", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.InvocationExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var invocation = (InvocationExpressionSyntax)context.Node;
        if (invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax })
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, invocation.GetLocation()));
        }
    }
}
`
        let (printed, diagnostics) = TranslateAnalyzerSource(AnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("invocation.Parent is BaseClassCallExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("AccessorExpressionSyntax", printed, StringComparison.Ordinal)
        AssertBinds(printed)
    }

    /// §4.5 drift test: the translator's own shared-node registry
    /// (`PlainAccessAnalyzerTypes` + `ConditionalAccessTypeName`,
    /// exposed via (cref:CSharpToGSharpTranslator.EnumerateAnalyzerSharedGsNodeTypeNames))
    /// must agree EXACTLY with (cref:RoslynAnalyzerApiMap)'s own
    /// `SharedGsNode`-flagged rows — if a future contributor adds a
    /// fourth shared-node map row and forgets to flag it (or vice versa),
    /// this test fails instead of silently shipping the over-match bug a
    /// fourth time.
    @Fact
    func SharedGsNodeRegistry_AgreesWithRoslynAnalyzerApiMap() {
        let expected = HashSet[string](StringComparer.Ordinal){
            "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax",
            "Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax",
            "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax"
        }
        let translatorRegistry = HashSet[string](
            CSharpToGSharpTranslator.EnumerateAnalyzerSharedGsNodeTypeNames(),
            StringComparer.Ordinal
        )
        let mapRegistry = HashSet[string](RoslynAnalyzerApiMap.EnumerateSharedGsNodeTypeNames(), StringComparer.Ordinal)
        Assert.Equal(expected, translatorRegistry)
        Assert.Equal(expected, mapRegistry)
    }

    @Fact
    func Review_PositiveGuardHoist_PlainAccessType_MatchesRoslyn() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            ReviewPositivePlainAccessSource,
            "ReviewPositivePlainAccessAnalyzer"
        )
        let roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV1")
        let roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer,
            Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"),
            "TESTREV1"
        )
        Assert.NotEmpty(
            roslynPlainIds
        ) // Roslyn: plain access fires (both the receiver and name identifiers' Parent is the MemberAccessExpressionSyntax).
        Assert.Empty(
            roslynConditionalIds
        ) // Roslyn: null-conditional tail is MemberBindingExpressionSyntax, not MemberAccessExpressionSyntax -- zero.
        let (printed, diagnostics) = TranslateAnalyzerSource(ReviewPositivePlainAccessSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("IsNullConditional", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReviewPositivePlainAccessSource,
            "ReviewPositivePlainAccess"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let plainDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`)
        let conditionalDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.Name
}`)
        Assert.NotEmpty(plainDiagnostics) // G#: fires on plain access, matching Roslyn.
        Assert.Empty(conditionalDiagnostics) // G#: MUST stay silent on null-conditional access, matching Roslyn.

    }

    @Fact
    func Review_NegatedGuardHoist_PlainAccessType_MatchesRoslyn() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            ReviewNegatedPlainAccessSource,
            "ReviewNegatedPlainAccessAnalyzer"
        )
        let roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV2")
        let roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer,
            Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"),
            "TESTREV2"
        )
        Assert.NotEmpty(roslynPlainIds)
        Assert.Empty(roslynConditionalIds)
        let (printed, diagnostics) = TranslateAnalyzerSource(ReviewNegatedPlainAccessSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReviewNegatedPlainAccessSource,
            "ReviewNegatedPlainAccess"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let plainDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`)
        let conditionalDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.Name
}`)
        Assert.NotEmpty(plainDiagnostics)
        Assert.Empty(conditionalDiagnostics) // Must NOT fire on the null-conditional tail.

    }

    @Fact
    func Review_MultipleNegatedGuardHoist_MixedSharedNodeTypes_MatchesRoslyn() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            ReviewMultiNegatedGuardHoistSource,
            "ReviewMultiNegatedGuardHoistAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, ReviewMultiNegatedCorpus, "TESTREV3")
        Assert.Single(roslynIds) // Roslyn: fires exactly once, on Fires().
        let (printed, diagnostics) = TranslateAnalyzerSource(ReviewMultiNegatedGuardHoistSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.Contains("IsNullConditional", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReviewMultiNegatedGuardHoistSource,
            "ReviewMultiNegatedGuardHoist"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let firesDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

func frobnicate(x Box?, y Box?) { }

class Box(Next Box?, Name string) { }

func fires(a Box?, b Box)
{
    frobnicate(a?.Next, b.Next)
}`)
        let noFireArg0PlainDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

func frobnicate(x Box?, y Box?) { }

class Box(Next Box?, Name string) { }

func noFireArg0Plain(a Box, b Box)
{
    frobnicate(a.Next, b.Next)
}`)
        let noFireArg1ConditionalDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

func frobnicate(x Box?, y Box?) { }

class Box(Next Box?, Name string) { }

func noFireArg1Conditional(a Box?, b Box?)
{
    frobnicate(a?.Next, b?.Next)
}`)
        Assert.NotEmpty(firesDiagnostics) // G#: must fire when BOTH conditions are satisfied.
        Assert.Empty(noFireArg0PlainDiagnostics) // G#: must NOT fire when arg0 is plain (not CAE).
        Assert.Empty(
            noFireArg1ConditionalDiagnostics
        ) // G#: must NOT fire when arg1 is null-conditional (not plain access).

    }

    @Fact
    func Review_OrCombinator_ArgumentPosition_ExactCountMatchesRoslyn() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            ReviewOrCombinatorArgumentSource,
            "ReviewOrCombinatorArgumentAnalyzer"
        )
        let roslynIds = RunRoslynAnalyzer(roslynAnalyzer, ReviewOrCombinatorCorpus, "TESTREV5")
        Assert.Equal(2, roslynIds.Count) // Roslyn: fires on ViaConditional and ViaPlain, not ViaNeither.
        let (printed, diagnostics) = TranslateAnalyzerSource(ReviewOrCombinatorArgumentSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        Assert.Contains("AccessorExpressionSyntax { IsNullConditional: false }", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReviewOrCombinatorArgumentSource,
            "ReviewOrCombinatorArgument"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let viaConditional = RunGsAnalyzer(analyzerDll, `package sample

func frobnicate(x Box?) { }

class Box(Next Box?, Name string) { }

func viaConditional(a Box?)
{
    frobnicate(a?.Next)
}`)
        let viaPlain = RunGsAnalyzer(analyzerDll, `package sample

func frobnicate(x Box?) { }

class Box(Next Box?, Name string) { }

func viaPlain(a Box)
{
    frobnicate(a.Next)
}`)
        let viaNeither = RunGsAnalyzer(analyzerDll, `package sample

func frobnicate(x Box?) { }

class Box(Next Box?, Name string) { }

func viaNeither(a Box?)
{
    frobnicate(a)
}`)
        Assert.NotEmpty(viaConditional) // G#: must fire, matching Roslyn.
        Assert.NotEmpty(viaPlain) // G#: must fire, matching Roslyn.
        Assert.Empty(viaNeither) // G#: must NOT fire, matching Roslyn.

    }

    @Fact
    func Review_RecursivePatternDesignator_ConditionalAccessType_BindsAndMatchesRoslyn() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            ReviewRecursivePatternDesignatorSource,
            "ReviewRecursivePatternDesignatorAnalyzer"
        )
        let roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV6")
        let roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer,
            Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"),
            "TESTREV6"
        )
        Assert.Empty(roslynPlainIds)
        Assert.Single(roslynConditionalIds)
        let (printed, diagnostics) = TranslateAnalyzerSource(ReviewRecursivePatternDesignatorSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReviewRecursivePatternDesignatorSource,
            "ReviewRecursivePatternDesignator"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let plainDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`)
        let conditionalDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.Name
}`)
        Assert.Empty(plainDiagnostics) // Must not fire on plain access.
        Assert.NotEmpty(
            conditionalDiagnostics
        ) // Must fire on null-conditional access, AND the designator binding used by GetLocation() must not crash/misbehave.

    }

    @Fact
    func Review_RecursivePatternDesignator_TernaryPosition_BindsAndMatchesRoslyn() {
        let roslynAnalyzer RoslynDiagnosticAnalyzer? = CompileRoslynAnalyzerFromSource(
            ReviewRecursivePatternTernaryDesignatorSource,
            "ReviewRecursivePatternTernaryDesignatorAnalyzer"
        )
        let roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV7")
        let roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer,
            Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"),
            "TESTREV7"
        )
        Assert.Empty(roslynPlainIds)
        Assert.Single(roslynConditionalIds)
        let (printed, diagnostics) = TranslateAnalyzerSource(ReviewRecursivePatternTernaryDesignatorSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal)
        AssertBinds(printed)
        let analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName,
            ReviewRecursivePatternTernaryDesignatorSource,
            "ReviewRecursivePatternTernaryDesignator"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let plainDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`)
        let conditionalDiagnostics = RunGsAnalyzer(analyzerDll, `package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return box?.Name
}`)
        Assert.Empty(plainDiagnostics)
        Assert.NotEmpty(conditionalDiagnostics)
    }

    shared {
        // Exercises BOTH idiom #1 (the `is ConditionalAccessExpressionSyntax`
        // type test — here redundantly re-checked inside the handler, since the
        // registration guard already narrowed context.Node) and idiom #2 (the
        // RegisterSyntaxNodeAction guard) in one realistic analyzer: reports on
        // every null-conditional access and nothing else.
        private const NullConditionalAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NullConditionalAccessAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, conditional.GetLocation()));
        }
    }
}
`

        /// The single-hop positive and negative parity cases.
        /// @returns The theory data.
        func ParityCases() sequence[[]object] {
            // Single-hop positive: `a?.b`.
            yield[]object{`package sample

class Box(Name string) { }

func Get(box Box?) string?
{
    return [|box?.Name|]
}`, []string{"TEST4173"}}
            // Negative: ordinary `.` access must NOT fire — the falsifier for the
            // property-pattern rewrite. Before the fix, a naive kind-rename (or
            // an unguarded registration) would have matched this too.
            yield[]object{`package sample

class Box(Name string) { }

func Get(box Box) string
{
    return box.Name
}`, Array.Empty[string]()}
            // Row 9: `a?[i]` — a null-conditional ELEMENT access. Before this PR,
            // I2's registration guard was accessor-only (SyntaxKind.AccessorExpression
            // alone), so an IndexExpressionSyntax hop never reached the handler at
            // all: a genuine under-fire (0 instead of 1), not merely a disclosed
            // gap. Now registers SyntaxKind.IndexExpression too.
            yield[]object{`package sample

func Get(nums []int32?) int32?
{
    return [|nums?[0]|]
}`, []string{"TEST4173"}}
            // Negative companion: an ORDINARY element access must NOT fire either.
            yield[]object{`package sample

func Get(nums []int32) int32
{
    return nums[0]
}`, Array.Empty[string]()}
        }

        // Analyzer B (tail test, I4): `x.WhenNotNull is MemberBindingExpressionSyntax`.
        // Fires exactly on the LAST operator of a chain when it ends in a bare
        // member name — not on every hop, and not on a hop whose WhenNotNull is
        // an ordinary (non-conditional) continuation. An earlier, unsound draft
        // of this idiom collapsed this to a per-node IsNullConditional check and
        // was confirmed, empirically, to over-fire (2 instead of Roslyn's 1 on a
        // genuine `a?.b?.c` chain; 1 instead of 0 on `a?.b.c`) — this analyzer
        // and its parity test below are the regression guard for that failure
        // mode (issue #4173's own removed idiom).
        private const TailMemberBindingAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class TailMemberBindingAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173B", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.WhenNotNull is MemberBindingExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        // C# corpus for TailMemberBindingAnalyzer: Chain is a genuine two-level
        // `a?.b?.c`; Mixed is `a?.b.c` (one ?. then an ORDINARY continuation) —
        // the second counterexample the removed idiom also over-fired on.
        private const TailMemberBindingChainCorpus string = `
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Chain(Box box) => box?.Next?.Leaf; }
`

        private const TailMemberBindingMixedCorpus string = `
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Mixed(Box box) => box?.Next.Leaf; }
`

        // Analyzer D (recursive chain walk, I4's ConditionalAccessExpressionSyntax
        // case): `x.WhenNotNull is ConditionalAccessExpressionSyntax nested` —
        // walks to the FURTHER null-conditional operator in the same chain.
        // Reports once per chain by only firing on the node whose WhenNotNull IS
        // a nested CAE (i.e. every node except the last).
        private const RecursiveChainWalkAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class RecursiveChainWalkAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173D", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.WhenNotNull is ConditionalAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        private const RecursiveChainWalkCorpus string = `
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Chain(Box box) => box?.Next?.Next?.Leaf; }
`

        // `.WhenNotNull` read as a bare VALUE (not consumed by another is-pattern
        // scrutinee I4 intercepts) has no G# counterpart and must stay a loud
        // CS2GS-GAP — I4 only intercepts `.WhenNotNull` in SCRUTINEE position.
        private const BareWhenNotNullValueAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BareWhenNotNullValueAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173BARE", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional)
        {
            ExpressionSyntax tail = conditional.WhenNotNull;
            context.ReportDiagnostic(Diagnostic.Create(Rule, tail.GetLocation()));
        }
    }
}
`

        // A registration combining ConditionalAccessExpression with another kind
        // in the SAME call: the guard would wrongly reject the other kind's
        // nodes, so this must be a loud gap rather than a silently wrong guard.
        private const MultiKindRegistrationAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class MultiKindRegistrationAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173E", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression, SyntaxKind.SimpleMemberAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
        => context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
}
`

        // Analyzer H (cast handler, I7): a BARE `context.Node is ConditionalAccessExpressionSyntax`
        // with NO designator — the commonest real-world spelling of a type probe.
        // This parses as the classic BinaryExpressionSyntax/IsExpression node,
        // not a pattern, so it exercises a SEPARATE cs2gs entry point than every
        // designated `is Type x` form the rest of this file uses. Without I1
        // reaching this shape too, I7's deliberately non-discriminating
        // ConditionalAccessExpressionSyntax -> ExpressionSyntax map row would let
        // this test vacuously (over-)match every ordinary access as well.
        private const BareCastHandlerAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BareCastHandlerAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173H", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        // Bare `x.Expression is ConditionalAccessExpressionSyntax` (I5's declined
        // case, undesignated form) must ALSO stay a loud gap, not fall through to
        // I7's vacuous supertype.
        private const BareReceiverConditionalAccessAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BareReceiverConditionalAccessAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173GAP", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.Expression is ConditionalAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        // Analyzer J (sibling bug #6, ordinary-access type test): a BARE
        // `node is MemberAccessExpressionSyntax` — the commonest real-world
        // spelling — registered for SimpleMemberAccessExpression.
        private const OrdinaryMemberAccessAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OrdinaryMemberAccessAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173J", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.SimpleMemberAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is MemberAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        // Row 15 (issue #4173 §6's critical parity check): `a?.b.c` has exactly
        // ONE genuine ordinary MemberAccessExpressionSyntax (the ".c" access —
        // ".b" is Roslyn's receiverless MemberBindingExpressionSyntax, a
        // DIFFERENT type). Before the sibling fix, G#'s unconditional
        // MemberAccessExpressionSyntax -> AccessorExpressionSyntax map row made
        // this over-fire: BOTH the ?.b hop (IsNullConditional:true) and the
        // ordinary .c hop are AccessorExpressionSyntax, so an unguarded rewrite
        // matched both.
        private const OrdinaryMemberAccessCorpus string = `
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Mixed(Box box) => box?.Next.Leaf; }
`

        // Analyzer K (sibling bug #6, registration guard in isolation): NO inner
        // type test at all — isolates whether the REGISTRATION itself correctly
        // excludes null-conditional hops, independent of I1b's handler-level fix.
        private const BareOrdinaryRegistrationAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BareOrdinaryRegistrationAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173K", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.SimpleMemberAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
        => context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
}
`

        // Analyzer C/I3a (receiver read + Roslyn-exact span): reports at
        // `conditional.Expression.GetLocation()` — I3's NullConditionalReceiver
        // rewrite composed with I3a's ReceiverSpan location rewrite.
        private const ReceiverLocationAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReceiverLocationAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173C", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, conditional.Expression.GetLocation()));
        }
    }
}
`

        // Analyzer F (inner-hop receiver test, I5): `conditional.Expression is
        // MemberBindingExpressionSyntax` on a TWO-level chain must fire on the
        // INNER hop only (the outer hop's receiver is the plain root 'a', an
        // IdentifierNameSyntax, matching none of I5's three positive cases).
        private const InnerHopReceiverTestAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class InnerHopReceiverTestAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173F", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.Expression is MemberBindingExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        private const InnerHopReceiverTestCorpus string = `
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Chain(Box box) => box?.Next?.Leaf; }
`

        // Analyzer G (name extraction, I6): binds a MemberBindingExpressionSyntax
        // designator via I4, then reads its `.Name` (I6's declarative MemberMap
        // row: MemberBindingExpressionSyntax.Name -> RightPart).
        private const NameExtractionAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NameExtractionAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173G", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.WhenNotNull is MemberBindingExpressionSyntax binding)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, binding.Name.GetLocation()));
        }
    }
}
`

        // Analyzer I (descendant walk, I8): `.OfType<ConditionalAccessExpressionSyntax>()`
        // over `DescendantNodesAndSelf()` — must match every hop in a chain, not
        // silently over-match every ordinary access (I7's supertype risk).
        private const DescendantWalkAnalyzerSource string = `
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class DescendantWalkAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173I", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.MethodDeclaration);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        foreach (ConditionalAccessExpressionSyntax conditional in
            context.Node.DescendantNodesAndSelf().OfType<ConditionalAccessExpressionSyntax>())
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, conditional.GetLocation()));
        }
    }
}
`

        // ---------------------------------------------------------------------
        // Round 3 (issue #4173, closing the round-2 review gap): §6's
        // over-matching bug generalized to EVERY pattern position a type test
        // can appear in — not just the 4 designated/bare top-level shapes I1/I1b/
        // I4/I5 already own. See CSharpToGSharpTranslator.Analyzers.cs §4.0
        // (PlainAccessAnalyzerTypes / ConditionalAccessTypeName / the
        // BuildPatternTypeTest / BuildTypeTestExpression builders) and the
        // PatternMentionsConditionalAccessType scan that routes any CAE-
        // mentioning is-pattern off the native-G#-pattern paths.
        // ---------------------------------------------------------------------
        // The round-2 reviewer's exact repro: a DESIGNATED, NEGATED type test
        // (`is not ConditionalAccessExpressionSyntax cae`) registered for
        // SyntaxKind.IdentifierName — a shape none of I1/I1b/I4/I5's top-level
        // entry point recognizes (it only matches a bare DeclarationPatternSyntax/
        // ConstantPatternSyntax/TypePatternSyntax, not one wrapped in a `not`),
        // so before round 3 it fell through to TranslatePattern's native-pattern
        // path with no CAE awareness — silently over-matching every IdentifierName
        // whose parent was ANY access, not just a null-conditional one.
        private const Round3NotDesignatedAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3NotDesignatedAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3A", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node.Parent is not ConditionalAccessExpressionSyntax cae)
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(Rule, cae.GetLocation()));
    }
}
`

        private const Round3PlainAccessCorpus string = `
public class Box { public string Name; }
public class Corpus { public static string Get(Box box) => box.Name; }
`

        // The POSITIVE, designated, early-return-adjacent sibling of the reviewer
        // counterexample: `if (x is ConditionalAccessExpressionSyntax cae) { ... }`
        // used as a statement-form guard with `cae` read INSIDE the guarded
        // block. This shape is eligible for the statement-level `if let`/
        // positive-guard-hoist machinery (CSharpToGSharpTranslator.IfLet.cs /
        // ControlFlow.cs) BEFORE it ever reaches TranslateIsPattern's own
        // analyzer-idiom entry point for some call orderings — those hoist
        // builders used to reach MapTypeSyntax directly (bypassing the CAE
        // predicate entirely); round 3 declines there and falls back to the
        // general lowering instead.
        private const Round3PositiveDesignatedAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3PositiveDesignatedAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3I", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node.Parent is ConditionalAccessExpressionSyntax cae)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, cae.GetLocation()));
        }
    }
}
`

        // The `or` combinator (bare, no designator): `is ConditionalAccessExpressionSyntax
        // or MemberAccessExpressionSyntax` — ONE combinator exercising BOTH of
        // §4.1's shared-node leaf fixes at once. IsNativelyExpressiblePattern
        // refuses the whole pattern (it mentions CAE), routing to the legacy
        // boolean lowering, where the `or` combinator's own `||` composition
        // (TranslatePatternTest's BinaryPatternSyntax case) is untouched — no
        // bespoke `or`-handling needed for CAE at all, proving the leaf-level fix
        // composes for free.
        private const Round3OrCombinatorAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3OrCombinatorAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3B", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node.Parent is ConditionalAccessExpressionSyntax or MemberAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
        }
    }
}
`

        // The `and` combinator with a designator: `is ConditionalAccessExpressionSyntax
        // cae and not null`. GS0390/CS8780 permit a designator under `and` — the
        // CAE leaf binds by substitution (§4.2(d)), and the designator must be
        // usable AFTER the whole `and` test (`cae.GetLocation()` below). The
        // second conjunct (`not null`) is trivially true whenever the CAE
        // predicate already matched (a CAE-typed value is never null once
        // AsNullConditionalHop proves it IS the hop) — deliberately: it exercises
        // the BinaryPatternSyntax "and" composition path itself, not any
        // CAE-specific member (CAE has no G# member surface to test against).
        private const Round3AndCombinatorAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3AndCombinatorAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3C", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node.Parent is ConditionalAccessExpressionSyntax cae and not null)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, cae.GetLocation()));
        }
    }
}
`

        // A CAE-mentioning pattern used as a SWITCH-CASE label: no sound G#
        // pattern exists for it (§4.3) — must be a loud CS2GS-GAP, not a silent
        // fallback to the non-discriminating ExpressionSyntax supertype.
        private const Round3SwitchLabelAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3SwitchLabelAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3D", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        switch (context.Node.Parent)
        {
            case ConditionalAccessExpressionSyntax cae:
                context.ReportDiagnostic(Diagnostic.Create(Rule, cae.GetLocation()));
                break;
        }
    }
}
`

        // A CAE-mentioning pattern used as a SWITCH-EXPRESSION arm: same gap as
        // the switch-case-label form above, different C# syntax.
        private const Round3SwitchExpressionArmAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3SwitchExpressionArmAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3E", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        bool isConditional = context.Node.Parent switch
        {
            ConditionalAccessExpressionSyntax => true,
            _ => false,
        };

        if (isConditional)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.Parent!.GetLocation()));
        }
    }
}
`

        // The nested-property-subpattern shape (§4.2(c)) that reaches
        // TranslatePatternTest with receiverSyntax == null (via AddTypedSubpatternTest,
        // which never passes it): a real, valid Roslyn shape reachable only through
        // a PARENTHESIZED chain break (`(a?.b)?.c`) — the ONE place Roslyn allows a
        // bare CAE to sit inside another node's typed property (ParenthesizedExpressionSyntax.Expression).
        private const Round3NestedSubpatternAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3NestedSubpatternAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3F", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ParenthesizedExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ParenthesizedExpressionSyntax { Expression: ConditionalAccessExpressionSyntax cae })
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, cae.GetLocation()));
        }
    }
}
`

        // The previously-unreported ElementAccessExpressionSyntax sibling of the
        // real-repo tier-1 switch-label bug (RewriterClonePreservationAnalyzer.cs:334),
        // modeled directly on that real shape.
        private const Round3ElementAccessSwitchLabelAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class Round3ElementAccessSwitchLabelAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4173R3G", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        switch (context.Node.Parent)
        {
            case ElementAccessExpressionSyntax access:
                context.ReportDiagnostic(Diagnostic.Create(Rule, access.GetLocation()));
                break;
        }
    }
}
`

        private const Round3ElementAccessSwitchLabelCorpus string = `
public class Box { public string this[int i] => ""; }
public class Corpus
{
    public static string Plain(Box box) => box[0];
    public static string? Conditional(Box? box) => box?[0];
}
`

        // =======================================================================
        // ADVERSARIAL REVIEW (round 3, not part of the implementer's own test
        // suite) — independent guard-hoist stress tests. Scratch, temporary.
        // =======================================================================
        // Positive guard-hoist (no early exit; TryBuildPositiveGuardHoist /
        // TryBuildIfLetGuard) over a PLAIN-ACCESS shared-node type
        // (MemberAccessExpressionSyntax), exercising the newly-added
        // `!t.IsNullConditional` guard conjunct rather than CAE's predicate swap.
        private const ReviewPositivePlainAccessSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReviewPositivePlainAccessAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTREV1", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node.Parent is MemberAccessExpressionSyntax m)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, m.GetLocation()));
        }
    }
}
`

        // Negated guard-clause form (early return) over the SAME plain-access
        // type -- TryBuildNegatedGuardHoist's De Morgan `|| t.IsNullConditional`
        // addition is the part under test here.
        private const ReviewNegatedPlainAccessSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReviewNegatedPlainAccessAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTREV2", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node.Parent is not MemberAccessExpressionSyntax m)
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(Rule, m.GetLocation()));
    }
}
`

        // Multi-condition negated guard hoist (TryBuildMultipleNegatedGuardHoists):
        // TWO negated designated patterns over TWO DIFFERENT shared-node types
        // (one CAE, one plain-access), joined by `||` in one early-return guard
        // clause, over two INDEPENDENT invocation arguments (so the two
        // conditions are independently controllable without any parenthesized-
        // chain-break trickery). This is the specific multi-condition path the
        // function name (TryBuildMultipleNegatedGuardHoists) calls out.
        private const ReviewMultiNegatedGuardHoistSource string = `
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReviewMultiNegatedGuardHoistAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTREV3", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.InvocationExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var invocation = (InvocationExpressionSyntax)context.Node;
        System.Collections.Generic.List<ExpressionSyntax> args =
            invocation.ArgumentList.Arguments.Select(a => a.Expression).ToList();
        if (args.Count != 2)
        {
            return;
        }

        if (args[0] is not ConditionalAccessExpressionSyntax cae
            || args[1] is not MemberAccessExpressionSyntax m)
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(Rule, invocation.GetLocation()));
    }
}
`

        private const ReviewMultiNegatedCorpus string = `
public class Box { public Box Next; public string Name; }
public class Corpus
{
    static void Frobnicate(object x, object y) { }

    // Both terms false (arg0 IS CAE, arg1 IS plain access): should fire.
    public static void Fires(Box a, Box b) => Frobnicate(a?.Next, b.Next);

    // arg0 negation true (plain, not CAE): must NOT fire.
    public static void NoFireArg0Plain(Box a, Box b) => Frobnicate(a.Next, b.Next);

    // arg1 negation true (CAE, not plain access): must NOT fire.
    public static void NoFireArg1Conditional(Box a, Box b) => Frobnicate(a?.Next, b?.Next);
}
`

        // Independent `or`-combinator execution-parity check (item 3b): tests the
        // SOLE invocation argument directly (not via a `.Parent` traversal, which
        // is where the PR's own OrCombinator test disclaims execution parity due
        // to an orthogonal G# NAME-token dispatch difference) so an exact
        // Roslyn-vs-G# diagnostic COUNT comparison is meaningful here.
        private const ReviewOrCombinatorArgumentSource string = `
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReviewOrCombinatorArgumentAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTREV5", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.InvocationExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var invocation = (InvocationExpressionSyntax)context.Node;
        ExpressionSyntax arg = invocation.ArgumentList.Arguments.Single().Expression;
        if (arg is ConditionalAccessExpressionSyntax or MemberAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, invocation.GetLocation()));
        }
    }
}
`

        private const ReviewOrCombinatorCorpus string = `
public class Box { public Box Next; public string Name; }
public class Corpus
{
    static void Frobnicate(object x) { }
    public static void ViaConditional(Box a) => Frobnicate(a?.Next);
    public static void ViaPlain(Box a) => Frobnicate(a.Next);
    public static void ViaNeither(Box a) => Frobnicate(a);
}
`

        // Item 8 audit finding: `TranslateRecursivePatternTest`'s OWN designator
        // binding (CSharpToGSharpTranslator.Patterns.cs line ~1586) calls
        // `BuildPatternNarrowingReplacement(receiver, receiverSyntax, recursive.Type)`
        // directly -- NOT through MapPatternTypeSyntax/BuildPatternTypeTest --
        // whenever the pattern is a DESIGNATED RecursivePatternSyntax (`is T { } x`,
        // forced by the empty/non-empty braces, as opposed to a bare
        // DeclarationPatternSyntax `is T x`). This is REACHABLE for a CAE type at
        // a top-level `is` position: PatternMentionsConditionalAccessType routes
        // the whole is-pattern to boolean lowering, and TranslatePatternTest's
        // RecursivePatternSyntax case delegates straight into
        // TranslateRecursivePatternTest, which is exactly where the unguarded
        // BuildPatternNarrowingReplacement call lives. The TEST itself is fixed
        // (BuildTypeTestExpression elsewhere in the same function), so this can
        // only affect what the designator BINDS to, not whether the branch fires
        // -- checking empirically whether the bound value is still usable/correct.
        private const ReviewRecursivePatternDesignatorSource string = (`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReviewRecursivePatternDesignatorAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTREV6", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        // The ` + "`" + `{ }` + "`" + ` (empty property-pattern clause) forces RecursivePatternSyntax
        // instead of DeclarationPatternSyntax -- TranslateRecursivePatternTest,
        // not TranslatePatternTest's own DeclarationPatternSyntax case.
        if (context.Node.Parent is ConditionalAccessExpressionSyntax { } cae)
        {
            // Reads the designator's bound value via a member access, so a
            // wrong/garbage binding would surface as a bind-time or runtime
            // failure, not just an unused variable.
            context.ReportDiagnostic(Diagnostic.Create(Rule, cae.GetLocation()));
        }
    }
}
`)

        // Sharper repro of the item-8 audit finding: forces TranslateRecursivePatternTest's
        // OWN designator-binding call down BuildPatternNarrowingReplacement's
        // "smart-castable bare receiver" branch (IsSmartCastableScrutinee=true
        // requires a bare local/parameter receiver AND the pattern NOT combined
        // via &&/||/when, which is exactly what a TERNARY condition gives — an
        // if-statement condition is instead intercepted by the guard-hoist
        // machinery before ever reaching TranslatePatternTest, masking the bug,
        // as the block-body-if repro above demonstrates by passing either way).
        // Before the fix this shape failed to bind at all (GS0158 "Cannot find
        // member SyntaxTree" / GS0130 "Function 'TextLocation' doesn't exist"):
        // the designator was bound to the bare, un-narrowed receiver instead of
        // NullConditionalChain.AsNullConditionalHop(receiver).
        private const ReviewRecursivePatternTernaryDesignatorSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReviewRecursivePatternTernaryDesignatorAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTREV7", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        SyntaxNode node = context.Node.Parent;
        Location loc = node is ConditionalAccessExpressionSyntax { } cae
            ? cae.GetLocation()
            : null;
        if (loc != null)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, loc));
        }
    }
}
`

        /// Translates one analyzer source in ADR-0169 analyzer mode.
        /// @param source The C# analyzer source.
        /// @returns The printed G# and the translation diagnostics.
        private func TranslateAnalyzerSource(source string)(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Analyzer.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
            let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == "Analyzer.cs")
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            return (printed, context.Diagnostics.ToList())
        }

        /// Binds printed G# against the real GSharp.Core and returns the errors, if any.
        /// @param printed The printed G# source.
        /// @returns The bind-time error messages (empty when it binds cleanly).
        private func TryGetBindErrors(printed string) IReadOnlyList[string] {
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(printed, "analyzer.gs"))
            using let resolver = ReferenceResolver.WithRuntimeReferences(
                []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}
            )
            let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree){IsLibrary = true}
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> (d.Id + ": " + d.Message))
                .ToList()
        }

        /// Binds printed G# against the real GSharp.Core, asserting no errors.
        /// @param printed The printed G# source.
        private func AssertBinds(printed string) {
            let errors = TryGetBindErrors(printed)
            Assert.True(errors.Count == 0, string.Join("\n", errors))
        }

        /// Translates and compiles a SELF-CONTAINED analyzer source (no
        /// dependency on the real `src/Analyzers/InternalAnalyzers` files on
        /// disk — issue #4173 has no live consumer there yet) into a loadable
        /// analyzer assembly, mirroring
        /// `Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer`.
        /// @param workDirectory The directory receiving the emitted dll.
        /// @param analyzerSource The C# analyzer source.
        /// @param assemblyName The emitted assembly name.
        /// @returns The analyzer assembly path.
        private func CompileTranslatedAnalyzerFromSource(
            workDirectory string,
            analyzerSource string,
            assemblyName string
        ) string {
            let (printed, diagnostics) = TranslateAnalyzerSource(analyzerSource)
            Assert.DoesNotContain(
                diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(printed, "analyzer.gs"))
            Assert.True(
                tree.Diagnostics.IsEmpty,
                string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))
            )
            using let resolver = ReferenceResolver.WithRuntimeReferences(
                []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}
            )
            let compilation = GSharp
                .Core
                .CodeAnalysis
                .Compilation
                .Compilation(resolver, tree){IsLibrary = true, AssemblyName = assemblyName}
            let dllPath = Path.Combine(workDirectory, assemblyName + ".dll")
            {
                using let peStream = File.Create(dllPath)
                let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
                Assert.True(result.Success, (`Translated ` + "$assemblyName" + ` should compile:
`) + string.Join(
                        "\n",
                        result
                            .Diagnostics
                            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                            .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                    ))
            }
            return dllPath
        }

        /// Runs a translated-and-compiled analyzer over a G# source and returns
        /// the diagnostics it produces, in source order — the G# side of every
        /// Roslyn-parity assertion below (mirrors
        /// `Adr0169AnalyzerParityTests.TranslatedGsa0001_MatchesRoslynGsa0001_OverTranslatedCorpus`'s
        /// step 4, generalized to arbitrary G# source instead of a translated
        /// C# corpus).
        /// @param analyzerDllPath The translated analyzer assembly.
        /// @param gsSource The G# source under analysis.
        /// @returns The produced diagnostics, ordered by span start.
        private func RunGsAnalyzer(analyzerDllPath string, gsSource string) ImmutableArray[
            GSharp.Core.CodeAnalysis.Diagnostic
        ] {
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(gsSource, "corpus.gs"))
            Assert.True(
                tree.Diagnostics.IsEmpty,
                string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)) +
                    "\n" +
                    gsSource
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
` + gsSource
            )
            return GSharpAnalyzerHost
                .Run(compilation, []string{analyzerDllPath})
                .OrderBy((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Location.Span.Start)
                .ToImmutableArray()
        }

        /// Compiles an analyzer's OWN C# source with Roslyn and instantiates it — the
        /// Roslyn-control half of every parity assertion below, generalized from
        /// `Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer` (which reads a real
        /// file from `src/Analyzers/InternalAnalyzers`) to this file's synthetic,
        /// self-contained analyzer sources (issue #4173 has no real repo consumer to read from).
        /// @param analyzerSource The C# analyzer source, declaring a type in namespace `Sample`.
        /// @param analyzerTypeName The analyzer type's simple name.
        /// @returns A live Roslyn analyzer instance.
        private func CompileRoslynAnalyzerFromSource(
            analyzerSource string,
            analyzerTypeName string
        ) RoslynDiagnosticAnalyzer? {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, analyzerSource string){("Analyzer.cs", analyzerSource)}
            )
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            using let peStream = MemoryStream()
            let emitResult = project.Compilation.Emit(peStream)
            Assert.True(emitResult.Success, (`Roslyn control analyzer ` + "$analyzerTypeName" + ` should compile:
`) + string.Join(
                    "\n",
                    emitResult.Diagnostics.Where(
                        (d Microsoft.CodeAnalysis.Diagnostic) -> d.Severity == Microsoft
                            .CodeAnalysis
                            .DiagnosticSeverity
                            .Error
                    )
                ))
            let assembly = Assembly.Load(peStream.ToArray())
            let analyzerType Type? = assembly.GetType("Sample." + analyzerTypeName, throwOnError: true)
            return cast[RoslynDiagnosticAnalyzer](Activator.CreateInstance(analyzerType!!))
        }

        /// Runs a live Roslyn analyzer over a C# corpus and returns the diagnostics
        /// it produces with [`diagnosticId`](paramref), in source order — the
        /// Roslyn-control side of every parity assertion below (mirrors
        /// `Adr0169AnalyzerParityTests.RunRoslynAnalyzer`).
        /// @param analyzer The Roslyn analyzer.
        /// @param corpusSource The C# corpus source.
        /// @param diagnosticId The diagnostic id to keep.
        /// @returns The matching diagnostic ids, in source order.
        private func RunRoslynAnalyzer(
            analyzer RoslynDiagnosticAnalyzer?,
            corpusSource string,
            diagnosticId string
        ) IReadOnlyList[string] {
            let corpus = CSharpProjectLoader.LoadInMemory([](string, corpusSource string){("Corpus.cs", corpusSource)})
            Assert.True(corpus.BoundWithoutErrors, string.Join("\n", corpus.ErrorDiagnostics))
            let withAnalyzers = corpus.Compilation.WithAnalyzers(ImmutableArray.Create(analyzer!!))
            return withAnalyzers
                .GetAnalyzerDiagnosticsAsync()
                .GetAwaiter()
                .GetResult()
                .Where((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id == diagnosticId)
                .OrderBy((d Microsoft.CodeAnalysis.Diagnostic) -> d.Location.SourceSpan.Start)
                .Select((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id)
                .ToList()
        }
    }
}
