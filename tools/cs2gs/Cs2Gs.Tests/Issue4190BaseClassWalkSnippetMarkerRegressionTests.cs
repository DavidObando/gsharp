// <copyright file="Issue4190BaseClassWalkSnippetMarkerRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4190: <c>test/InternalAnalyzers.Tests</c> dropped from fully green
/// (translate/compile/ilverify/test-parity) back to a translate-stage failure
/// after PR #4172 added <c>BaseClassCycleUnsafeWalkAnalyzerTests.cs</c>, whose
/// three <c>[|…|]</c>-marked snippets (<c>ReportsForLoopWalk</c>,
/// <c>ReportsWhileLoopWalk</c>, <c>ReportsDoWhileLoopWalk</c>) all failed to
/// re-place their marker after translation.
///
/// <para>
/// <b>Two distinct root causes, both real bugs, fixed independently:</b>
/// </para>
/// <para>
/// <b>#4177 (parser).</b> <c>ReportsForLoopWalk</c>'s translated G# was
/// outright UNPARSEABLE (<c>GS0005: Unexpected token &lt;CloseBraceToken&gt;,
/// expected &lt;IdentifierToken&gt;</c>), so the marker text obviously could
/// not survive verbatim inside garbage. Root cause:
/// <c>Parser.ParseForClauseStatement</c>'s post-clause suppressed the
/// composite-literal wrap (<c>suppressTrailingObjectInitializer</c>, issue
/// #1023) but never the separate BARE struct-literal form
/// (<c>suppressStructLiteral</c>). A post-clause ending in a bare member name
/// immediately followed by an EMPTY loop body — exactly
/// <c>c = c!!.Next { }</c> — misparsed <c>Next { }</c> as an empty struct
/// literal, swallowing the loop's own body brace and desyncing the parser.
/// Fixed by also suppressing <c>suppressStructLiteral</c> around the
/// post-clause parse, mirroring <c>ParseExpressionInBodyHeader</c>'s existing
/// #1575 fix for <c>if</c>/<c>while</c>/for-range headers.
/// </para>
/// <para>
/// <b>#4190 residual (marker matching).</b> Once #4177 was fixed, all three
/// snippets translate to VALID G# — but the marker text still failed to
/// re-place, because cs2gs's oblivious-mode nullable bridge inserts a runtime
/// <c>!!</c> assertion on the reassigned receiver
/// (<c>current = current.BaseClass</c> prints as
/// <c>current = current!!.BaseClass</c>). This is not a translation defect:
/// <c>BaseClassCycleUnsafeWalkAnalyzer.GetBaseClassAccess</c> already
/// documents and unwraps exactly this shape (issue #4173), and for the
/// <c>do</c>/<c>while</c> case the assertion is not merely conservative —
/// G#'s own <c>do</c>/<c>while</c> binder
/// (<c>StatementBinder.Loops.BindDoWhileStatementCore</c>) applies no
/// post-test narrowing at all, so the bridging <c>!!</c> is REQUIRED for the
/// translated code to bind. <c>SnippetTranslator</c>'s exact-text marker
/// placement (issue #3778) and its one lexical-rename retry (issue #3797)
/// could not anticipate a flow-sensitive insertion invisible from inside the
/// marked region alone, so it is fixed the same way #3797 was: a new
/// tolerant-match fallback (<see cref="SnippetTranslator"/>'s
/// <c>TryNullForgivingTolerantOccurrence</c>) that accepts the marked text
/// with an optional <c>!!</c> tolerated after every identifier, keeping every
/// other character an exact literal match.
/// </para>
/// <para>
/// Every assertion here EXECUTES the real path: the real snippets (copied
/// verbatim from <c>BaseClassCycleUnsafeWalkAnalyzerTests.cs</c>) are
/// translated by the real <see cref="SnippetTranslator"/>, and the real
/// GSA0006 analyzer — translated and compiled by the real G# compiler — is
/// run by <see cref="GSharpAnalyzerVerifier"/> over the re-placed markers,
/// mirroring <c>Issue3794AnalyzerSnippetPackageSplitTests</c>.
/// </para>
/// </summary>
public sealed class Issue4190BaseClassWalkSnippetMarkerRegressionTests : IDisposable
{
    // Copied verbatim from
    // test/InternalAnalyzers.Tests/BaseClassCycleUnsafeWalkAnalyzerTests.cs's
    // ReportsForLoopWalk.
    private const string ForLoopWalk = """
class StructSymbol
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
}
""";

    // Copied verbatim from ReportsWhileLoopWalk.
    private const string WhileLoopWalk = """
class StructSymbol
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
}
""";

    // Copied verbatim from ReportsDoWhileLoopWalk.
    private const string DoWhileLoopWalk = """
class StructSymbol
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
}
""";

    private readonly DirectoryInfo workDirectory =
        Directory.CreateTempSubdirectory("cs2gs-issue4190-baseclass-walk");

    public void Dispose()
    {
        try
        {
            workDirectory.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Theory]
    [InlineData(ForLoopWalk)]
    [InlineData(WhileLoopWalk)]
    [InlineData(DoWhileLoopWalk)]
    public void Marker_SurvivesTranslation_WithNoUnplacedMarkerDiagnostic(string markedSnippet)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
                && d.Message.Contains("does not survive translation verbatim", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(ForLoopWalk)]
    [InlineData(WhileLoopWalk)]
    [InlineData(DoWhileLoopWalk)]
    public void TranslatedSnippet_IsValidG_AndRoundTrips(string markedSnippet)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);
        Assert.NotNull(result.GsWithMarkers);

        // Markers are test-harness syntax, not G# — strip them before parsing,
        // exactly as GSharpAnalyzerVerifier does.
        string withoutMarkers = result.GsWithMarkers.Replace("[|", string.Empty).Replace("|]", string.Empty);
        TranslationTestValidation.AssertBinds(withoutMarkers);
    }

    /// <summary>
    /// The translated <c>ReportsForLoopWalk</c> shape still needs the `!!`
    /// bridge cs2gs's oblivious nullable analysis inserts — this is #4190's
    /// point, not #4177's: #4177 made the shape PARSEABLE, it did not (and
    /// must not) remove the bridging assertion.
    /// </summary>
    [Fact]
    public void ForLoopWalk_TranslatesWithBangBangBridge_OnTheReassignedReceiver()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(ForLoopWalk);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Contains("c!!.BaseClass", result.GsWithMarkers, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(WhileLoopWalk)]
    [InlineData(DoWhileLoopWalk)]
    public void LoopWalk_TranslatesWithBangBangBridge_OnTheReassignedReceiver(string markedSnippet)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Contains("current!!.BaseClass", result.GsWithMarkers, StringComparison.Ordinal);
    }

    /// <summary>
    /// End to end, the whole reason the marker must survive: the real
    /// GSA0006 analyzer, translated and compiled by the real G# compiler,
    /// reports at exactly the re-placed marker for all three loop shapes.
    /// </summary>
    /// <param name="markedSnippet">The C# snippet with its marker.</param>
    [Theory]
    [InlineData(ForLoopWalk)]
    [InlineData(WhileLoopWalk)]
    [InlineData(DoWhileLoopWalk)]
    public void TranslatedGsa0006_FiresAtTheRePlacedMarker(string markedSnippet)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);

        string analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName, "BaseClassCycleUnsafeWalkAnalyzer.cs", "TranslatedGsa0006");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, result.GsWithMarkers, new[] { "GSA0006" });
    }

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
    private const string MixedBridgedAndExactBaseClassAccess = """
    using System.IO;

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
    }
    """;

    /// <summary>
    /// Before the fix, the plain exact-only search silently SUCCEEDS at the
    /// wrong occurrence instead of failing over to the tolerant fallback:
    /// the FIRST marker (M1, whose own occurrence gets bridged) steals the
    /// SECOND marker's (M2's) exact span via <c>NthOccurrence</c>, and the
    /// SECOND marker then also resolves onto M2's span via the tolerant
    /// fallback — both markers land on the SAME (M2's) span, nested
    /// (<c>[|[|Path.GetFullPath(x.|]F)|]</c>), and M1's own occurrence gets
    /// no marker at all. The fix (a single unified exact-or-tolerant ordinal
    /// sequence for non-declaration markers) must place each marker on its
    /// own, distinct, correct span instead.
    /// </summary>
    [Fact]
    public void MixedBridgedAndExactOccurrences_PlaceEachMarkerOnItsOwnDistinctSpan()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(MixedBridgedAndExactBaseClassAccess);

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
                && d.Message.Contains("does not survive translation verbatim", StringComparison.Ordinal));

        // Exactly two markers, each wrapping its own method's call — never
        // both wrapping the same span, and never nested/overlapping.
        int m1Index = result.GsWithMarkers.IndexOf("func M1(", StringComparison.Ordinal);
        int m2Index = result.GsWithMarkers.IndexOf("func M2(", StringComparison.Ordinal);
        Assert.True(m1Index >= 0 && m2Index > m1Index);

        string m1Body = result.GsWithMarkers.Substring(m1Index, m2Index - m1Index);
        string m2Body = result.GsWithMarkers.Substring(m2Index);

        Assert.Contains("[|Path.GetFullPath(x.F!!)|]", m1Body);
        Assert.Contains("[|Path.GetFullPath(x.F)|]", m2Body);

        // M2's span (the non-bridged one) must never itself contain a `!!` —
        // the bug's symptom was M1's marker stealing M2's un-bridged span.
        Assert.DoesNotContain("!!", m2Body.Substring(0, m2Body.IndexOf("].ToString()", StringComparison.Ordinal)));
    }
}
