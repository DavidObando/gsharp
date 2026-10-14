// <copyright file="Issue4190BaseClassWalkSnippetMarkerRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import Xunit

/// Issue #4190: `test/InternalAnalyzers.Tests` dropped from fully green
/// (translate/compile/ilverify/test-parity) back to a translate-stage failure
/// after PR #4172 added `BaseClassCycleUnsafeWalkAnalyzerTests.cs`, whose
/// three `[|…|]`-marked snippets (`ReportsForLoopWalk`,
/// `ReportsWhileLoopWalk`, `ReportsDoWhileLoopWalk`) all failed to
/// re-place their marker after translation.
///
/// <b>Two distinct root causes, both real bugs, fixed independently:</b>
///
/// <b>#4177 (parser).</b> `ReportsForLoopWalk`'s translated G# was
/// outright UNPARSEABLE (`GS0005: Unexpected token <CloseBraceToken>,
/// expected <IdentifierToken>`), so the marker text obviously could
/// not survive verbatim inside garbage. Root cause:
/// `Parser.ParseForClauseStatement`'s post-clause suppressed the
/// composite-literal wrap (`suppressTrailingObjectInitializer`, issue
/// #1023) but never the separate BARE struct-literal form
/// (`suppressStructLiteral`). A post-clause ending in a bare member name
/// immediately followed by an EMPTY loop body — exactly
/// `c = c!!.Next { }` — misparsed `Next { }` as an empty struct
/// literal, swallowing the loop's own body brace and desyncing the parser.
/// Fixed by also suppressing `suppressStructLiteral` around the
/// post-clause parse, mirroring `ParseExpressionInBodyHeader`'s existing
/// #1575 fix for `if`/`while`/for-range headers.
///
/// <b>#4190 residual (marker matching).</b> Once #4177 was fixed, all three
/// snippets translate to VALID G# — but the marker text still failed to
/// re-place, because cs2gs's oblivious-mode nullable bridge inserts a runtime
/// `!!` assertion on the reassigned receiver
/// (`current = current.BaseClass` prints as
/// `current = current!!.BaseClass`). This is not a translation defect:
/// `BaseClassCycleUnsafeWalkAnalyzer.GetBaseClassAccess` already
/// documents and unwraps exactly this shape (issue #4173), and for the
/// `do`/`while` case the assertion is not merely conservative —
/// G#'s own `do`/`while` binder
/// (`StatementBinder.Loops.BindDoWhileStatementCore`) applies no
/// post-test narrowing at all, so the bridging `!!` is REQUIRED for the
/// translated code to bind. `SnippetTranslator`'s exact-text marker
/// placement (issue #3778) and its one lexical-rename retry (issue #3797)
/// could not anticipate a flow-sensitive insertion invisible from inside the
/// marked region alone, so it is fixed the same way #3797 was: a new
/// tolerant-match fallback ((cref:SnippetTranslator)'s
/// `TryNullForgivingTolerantOccurrence`) that accepts the marked text
/// with an optional `!!` tolerated after every identifier, keeping every
/// other character an exact literal match.
///
/// Every assertion here EXECUTES the real path: the real snippets (copied
/// verbatim from `BaseClassCycleUnsafeWalkAnalyzerTests.cs`) are
/// translated by the real (cref:SnippetTranslator), and the real
/// GSA0006 analyzer — translated and compiled by the real G# compiler — is
/// run by (cref:GSharpAnalyzerVerifier) over the re-placed markers,
/// mirroring `Issue3794AnalyzerSnippetPackageSplitTests`.
class Issue4190BaseClassWalkSnippetMarkerRegressionTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-issue4190-baseclass-walk")

    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    @Theory
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        for (var c = s.BaseClass; c != null; [|c = c.BaseClass|])
        {
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current.BaseClass|];
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            [|current = current.BaseClass|];
        }
        while (current != null);
    }
}`)
    func Marker_SurvivesTranslation_WithNoUnplacedMarkerDiagnostic(markedSnippet string) {
        let result = SnippetTranslator.Translate(markedSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        Assert.DoesNotContain(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId &&
                d.Message!!.Contains("does not survive translation verbatim", StringComparison.Ordinal)
        )
    }

    @Theory
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        for (var c = s.BaseClass; c != null; [|c = c.BaseClass|])
        {
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current.BaseClass|];
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            [|current = current.BaseClass|];
        }
        while (current != null);
    }
}`)
    func TranslatedSnippet_IsValidG_AndRoundTrips(markedSnippet string) {
        let result = SnippetTranslator.Translate(markedSnippet)
        Assert.NotNull(result.GsWithMarkers)
        // Markers are test-harness syntax, not G# — strip them before parsing,
        // exactly as GSharpAnalyzerVerifier does.
        let withoutMarkers = result.GsWithMarkers!!.Replace("[|", string.Empty).Replace("|]", string.Empty)
        TranslationTestValidation.AssertBinds(withoutMarkers)
    }

    /// The translated `ReportsForLoopWalk` shape still needs the `!!`
    /// bridge cs2gs's oblivious nullable analysis inserts — this is #4190's
    /// point, not #4177's: #4177 made the shape PARSEABLE, it did not (and
    /// must not) remove the bridging assertion.
    @Fact
    func ForLoopWalk_TranslatesWithBangBangBridge_OnTheReassignedReceiver() {
        let result = SnippetTranslator.Translate(ForLoopWalk)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Contains("c!!.BaseClass", result.GsWithMarkers, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current.BaseClass|];
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            [|current = current.BaseClass|];
        }
        while (current != null);
    }
}`)
    func LoopWalk_TranslatesWithBangBangBridge_OnTheReassignedReceiver(markedSnippet string) {
        let result = SnippetTranslator.Translate(markedSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Contains("current!!.BaseClass", result.GsWithMarkers, StringComparison.Ordinal)
    }

    /// End to end, the whole reason the marker must survive: the real
    /// GSA0006 analyzer, translated and compiled by the real G# compiler,
    /// reports at exactly the re-placed marker for all three loop shapes.
    /// @param markedSnippet The C# snippet with its marker.
    @Theory
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        for (var c = s.BaseClass; c != null; [|c = c.BaseClass|])
        {
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current.BaseClass|];
        }
    }
}`)
    @InlineData(`class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            [|current = current.BaseClass|];
        }
        while (current != null);
    }
}`)
    func TranslatedGsa0006_FiresAtTheRePlacedMarker(markedSnippet string) {
        let result = SnippetTranslator.Translate(markedSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName,
            "BaseClassCycleUnsafeWalkAnalyzer.cs",
            "TranslatedGsa0006"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp
            .CodeAnalysis
            .Analyzers
            .Testing
            .GSharpAnalyzerVerifier
            .VerifyAnalyzer(analyzer, result.GsWithMarkers!!, []string{"GSA0006"})
    }

    /// Before the fix, the plain exact-only search silently SUCCEEDS at the
    /// wrong occurrence instead of failing over to the tolerant fallback:
    /// the FIRST marker (M1, whose own occurrence gets bridged) steals the
    /// SECOND marker's (M2's) exact span via `NthOccurrence`, and the
    /// SECOND marker then also resolves onto M2's span via the tolerant
    /// fallback — both markers land on the SAME (M2's) span, nested
    /// (`[|[|Path.GetFullPath(x.|]F)|]`), and M1's own occurrence gets
    /// no marker at all. The fix (a single unified exact-or-tolerant ordinal
    /// sequence for non-declaration markers) must place each marker on its
    /// own, distinct, correct span instead.
    @Fact
    func MixedBridgedAndExactOccurrences_PlaceEachMarkerOnItsOwnDistinctSpan() {
        let result = SnippetTranslator.Translate(MixedBridgedAndExactBaseClassAccess)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        Assert.DoesNotContain(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId &&
                d.Message!!.Contains("does not survive translation verbatim", StringComparison.Ordinal)
        )
        // Exactly two markers, each wrapping its own method's call — never
        // both wrapping the same span, and never nested/overlapping.
        let m1Index = result.GsWithMarkers!!.IndexOf("func M1(", StringComparison.Ordinal)
        let m2Index = result.GsWithMarkers!!.IndexOf("func M2(", StringComparison.Ordinal)
        Assert.True(m1Index >= 0 && m2Index > m1Index)
        let m1Body = result.GsWithMarkers!!.Substring(m1Index, m2Index - m1Index)
        let m2Body = result.GsWithMarkers!!.Substring(m2Index)
        Assert.Contains("[|Path.GetFullPath(x.F!!)|]", m1Body)
        Assert.Contains("[|Path.GetFullPath(x.F)|]", m2Body)
        // M2's span (the non-bridged one) must never itself contain a `!!` —
        // the bug's symptom was M1's marker stealing M2's un-bridged span.
        Assert.DoesNotContain("!!", m2Body.Substring(0, m2Body.IndexOf("].ToString()", StringComparison.Ordinal)))
    }

    shared {
        // Copied verbatim from
        // test/InternalAnalyzers.Tests/BaseClassCycleUnsafeWalkAnalyzerTests.cs's
        // ReportsForLoopWalk.
        private const ForLoopWalk string = `class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        for (var c = s.BaseClass; c != null; [|c = c.BaseClass|])
        {
        }
    }
}`

        // Copied verbatim from ReportsWhileLoopWalk.
        private const WhileLoopWalk string = `class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current.BaseClass|];
        }
    }
}`

        // Copied verbatim from ReportsDoWhileLoopWalk.
        private const DoWhileLoopWalk string = `class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            [|current = current.BaseClass|];
        }
        while (current != null);
    }
}`

        // Copilot review follow-up on PR #4191: TWO occurrences of the exact same
        // marker text (`Path.GetFullPath(x.F)`), where translation bridges only
        // the FIRST with `!!` (x.F is `string?` on NullHolder) and leaves the
        // SECOND, later occurrence exact (x.F is non-null `string` on
        // NonNullHolder — a different, unrelated declaration, so nothing narrows
        // it, it is simply never nullable). This is the mixed-context shape the
        // review flagged: the earlier occurrence "drops out" of the exact-text
        // sequence once bridged, while the later one does not, so an exact-only
        // ordinal search computed from the C# source no longer lines up with an
        // exact-only search over the printed G#.
        private const MixedBridgedAndExactBaseClassAccess string = `using System.IO;

class NullHolder
{
    public string? F;
}

class NonNullHolder
{
    public string F = "";
}

class Walker
{
    public void M1(NullHolder x)
    {
        [|Path.GetFullPath(x.F)|].ToString();
    }

    public void M2(NonNullHolder x)
    {
        [|Path.GetFullPath(x.F)|].ToString();
    }
}`
    }
}
