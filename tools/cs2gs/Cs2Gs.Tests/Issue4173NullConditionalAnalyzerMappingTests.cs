// <copyright file="Issue4173NullConditionalAnalyzerMappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;
using RoslynDiagnosticAnalyzer = Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4173: cs2gs's ADR-0169 analyzer-translation mode had no idiom for
/// C#'s null-conditional-access syntax (<c>ConditionalAccessExpressionSyntax</c>
/// / <c>MemberBindingExpressionSyntax</c>). G# represents <c>a?.b</c> as the
/// SAME node as <c>a.b</c> (<c>AccessorExpressionSyntax</c>) with a boolean
/// <c>IsNullConditional</c> flag rather than a distinct kind, so a naive
/// type/kind map-row extension (the pattern that fixed this file's other
/// analyzer-API gaps) would have silently matched every ordinary member
/// access — this is fixed as an idiom-level rewrite in
/// <c>CSharpToGSharpTranslator.Analyzers.cs</c> instead:
/// <list type="bullet">
/// <item><c>expr is ConditionalAccessExpressionSyntax x</c> → <c>expr is
/// AccessorExpressionSyntax { IsNullConditional: true } x</c>.</item>
/// <item><c>RegisterSyntaxNodeAction(handler, SyntaxKind.ConditionalAccessExpression)</c>
/// → a guarded wrapper lambda registered for <c>SyntaxKind.AccessorExpression</c>.</item>
/// </list>
/// <c>MemberBindingExpressionSyntax</c>/<c>ElementBindingExpressionSyntax</c>
/// (including <c>x.WhenNotNull is MemberBindingExpressionSyntax</c>, a
/// companion test some analyzers use to try to prove a single-hop access)
/// deliberately stay unmapped — a direct reference is a loud gap, not a bug.
/// A per-node type/kind test cannot actually distinguish "this is the last
/// hop of its chain" in Roslyn's tree shape from "this is not": a REAL Roslyn
/// tree for <c>a?.b?.c</c> contains an INNER <c>ConditionalAccessExpressionSyntax</c>
/// node (<c>Expression: MemberBindingExpressionSyntax(.b)</c>,
/// <c>WhenNotNull: MemberBindingExpressionSyntax(.c)</c>) whose own
/// <c>WhenNotNull</c> IS a bare <c>MemberBindingExpressionSyntax</c> — so the
/// conjunction is provably true on a genuine two-level chain, not only on a
/// true single-hop <c>a?.b</c>. A translator-side rewrite of that conjunction
/// to a per-G#-node <c>IsNullConditional</c> check therefore cannot preserve
/// Roslyn's semantics: it was empirically confirmed to over-fire (2 reports
/// instead of Roslyn's 1 for a chain, 1 instead of 0 for <c>a?.b.c</c>), the
/// same silent-over-match failure class the issue's own investigation warned
/// a naive map-row extension would cause. So the safe behavior — matching the
/// already-unmapped <c>AssignmentExpressionSyntax.Left</c> — is a loud
/// <c>CS2GS-GAP</c> on any surviving <c>.WhenNotNull</c>/<c>.Expression</c>
/// read, single-hop-proving conjunction or not.
/// <para>
/// Every assertion that can execute a real analyzer does: the analyzer source
/// is translated by the real <see cref="CSharpToGSharpTranslator"/>, compiled
/// by the real G# compiler, loaded, and run through the real
/// <see cref="GSharpAnalyzerVerifier"/> over real G# source — the same
/// methodology <c>Issue3920Gsa0002ImportedOperandDispatchTests</c> uses.
/// </para>
/// </summary>
public sealed class Issue4173NullConditionalAnalyzerMappingTests : IDisposable
{
    // Exercises BOTH idiom #1 (the `is ConditionalAccessExpressionSyntax`
    // type test — here redundantly re-checked inside the handler, since the
    // registration guard already narrowed context.Node) and idiom #2 (the
    // RegisterSyntaxNodeAction guard) in one realistic analyzer: reports on
    // every null-conditional access and nothing else.
    private const string NullConditionalAnalyzerSource = @"
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
        ""TEST4173"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private readonly DirectoryInfo workDirectory =
        Directory.CreateTempSubdirectory("cs2gs-issue4173-null-conditional");

    /// <inheritdoc/>
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

    /// <summary>
    /// Positive/negative parity, executed end to end: the translated analyzer
    /// fires on every null-conditional access (single-hop AND the two levels
    /// of a chain) and stays silent on an ordinary access — proving the
    /// property-pattern rewrite discriminates the flag rather than the naive
    /// kind-rename's constant match on every access.
    /// </summary>
    /// <param name="gsSource">The G# source under test, with markers.</param>
    /// <param name="ids">The expected diagnostic ids, one per marker.</param>
    [Theory]
    [MemberData(nameof(ParityCases))]
    public void TranslatedAnalyzer_FiresOnNullConditionalAccess_NotOnOrdinaryAccess(string gsSource, string[] ids)
    {
        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, NullConditionalAnalyzerSource, "TranslatedIssue4173");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, gsSource, ids);
    }

    /// <summary>The single-hop positive and negative parity cases.</summary>
    /// <returns>The theory data.</returns>
    public static IEnumerable<object[]> ParityCases()
    {
        // Single-hop positive: `a?.b`.
        yield return new object[]
        {
            """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return [|box?.Name|]
            }
            """,
            new[] { "TEST4173" },
        };

        // Negative: ordinary `.` access must NOT fire — the falsifier for the
        // property-pattern rewrite. Before the fix, a naive kind-rename (or
        // an unguarded registration) would have matched this too.
        yield return new object[]
        {
            """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """,
            Array.Empty<string>(),
        };

        // Row 9: `a?[i]` — a null-conditional ELEMENT access. Before this PR,
        // I2's registration guard was accessor-only (SyntaxKind.AccessorExpression
        // alone), so an IndexExpressionSyntax hop never reached the handler at
        // all: a genuine under-fire (0 instead of 1), not merely a disclosed
        // gap. Now registers SyntaxKind.IndexExpression too.
        yield return new object[]
        {
            """
            package sample

            func Get(nums []int32?) int32?
            {
                return [|nums?[0]|]
            }
            """,
            new[] { "TEST4173" },
        };

        // Negative companion: an ORDINARY element access must NOT fire either.
        yield return new object[]
        {
            """
            package sample

            func Get(nums []int32) int32
            {
                return nums[0]
            }
            """,
            Array.Empty<string>(),
        };
    }

    /// <summary>
    /// Chain positive: <c>a?.b?.c</c> parses left-associatively into TWO
    /// nested <c>AccessorExpressionSyntax</c> nodes, each carrying its own
    /// <c>IsNullConditional</c> — both must fire, proving the property-pattern
    /// rewrite (and the registration guard) is chain-safe. Both nodes share
    /// the same leftmost source position (left-recursive nesting), which the
    /// marker-based <see cref="GSharpAnalyzerVerifier"/> cannot disambiguate,
    /// so this drives <see cref="GSharpAnalyzerDriver"/> directly and asserts
    /// the diagnostic COUNT instead.
    /// </summary>
    [Fact]
    public void ChainCase_BothNullConditionalLevelsReported()
    {
        const string GsSource = """
            package sample

            class Leaf(Value string) { }

            class Box(Next Box?, Leaf Leaf?) { }

            func Get(box Box?) Leaf?
            {
                return box?.Next?.Leaf
            }
            """;

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, NullConditionalAnalyzerSource, "TranslatedIssue4173Chain");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(GsSource, "chain.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        Assert.True(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).All(d => !d.IsError),
            "chain.gs should bind");

        ImmutableArray<Diagnostic> diagnostics = GSharpAnalyzerDriver.Run(
            compilation, ImmutableArray.Create(analyzer));

        Assert.Equal(2, diagnostics.Length);
        Assert.All(diagnostics, d => Assert.Equal("TEST4173", d.Id));

        // Both null-conditional levels (`box?.Next` and `(box?.Next)?.Leaf`)
        // must be distinct nodes reported, not the same node twice.
        Assert.Equal(2, diagnostics.Select(d => d.Location.Span).Distinct().Count());
    }

    /// <summary>
    /// The <c>is ConditionalAccessExpressionSyntax x</c> idiom in isolation:
    /// the printed G# carries the property-pattern rewrite, not a bare
    /// (over-matching) kind rename, and it binds against the real G# compiler.
    /// </summary>
    [Fact]
    public void TypeTest_TranslatesToPropertyPatternAndBinds()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(NullConditionalAnalyzerSource);

        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.Contains("ExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ConditionalAccessExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);
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
    private const string TailMemberBindingAnalyzerSource = @"
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
        ""TEST4173B"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    // C# corpus for TailMemberBindingAnalyzer: Chain is a genuine two-level
    // `a?.b?.c`; Mixed is `a?.b.c` (one ?. then an ORDINARY continuation) —
    // the second counterexample the removed idiom also over-fired on.
    private const string TailMemberBindingChainCorpus = @"
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Chain(Box box) => box?.Next?.Leaf; }
";

    private const string TailMemberBindingMixedCorpus = @"
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Mixed(Box box) => box?.Next.Leaf; }
";

    /// <summary>
    /// Row 3 / row 5 (issue #4173's critical parity checks): the tail-test
    /// idiom fires exactly once on a genuine <c>a?.b?.c</c> chain (row 3 —
    /// the removed idiom's over-fire repro, which reported 2) and exactly
    /// zero times on <c>a?.b.c</c> (row 5 — the removed idiom's second
    /// counterexample, which reported 1), matching Roslyn exactly on both.
    /// </summary>
    [Fact]
    public void TailMemberBindingTest_MatchesRoslyn_OnChainAndMixedInputs()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(TailMemberBindingAnalyzerSource, "TailMemberBindingAnalyzer");
        IReadOnlyList<string> roslynChainIds = RunRoslynAnalyzer(roslynAnalyzer, TailMemberBindingChainCorpus, "TEST4173B");
        IReadOnlyList<string> roslynMixedIds = RunRoslynAnalyzer(roslynAnalyzer, TailMemberBindingMixedCorpus, "TEST4173B");
        Assert.Equal(new[] { "TEST4173B" }, roslynChainIds); // Row 3: Roslyn fires exactly once.
        Assert.Empty(roslynMixedIds); // Row 5: Roslyn fires zero times.

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, TailMemberBindingAnalyzerSource, "TranslatedTailMemberBinding");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string ChainGsSource = """
            package sample

            class Leaf(Value string) { }
            class Box(Next Box?, Leaf Leaf?) { }

            func Chain(box Box?) Leaf?
            {
                return box?.Next?.Leaf
            }
            """;
        const string MixedGsSource = """
            package sample

            class Leaf(Value string) { }
            class Mid(Leaf Leaf, Next Mid) { }
            class Root(Mid Mid) { }

            func Mixed(root Root?) Leaf?
            {
                return root?.Mid.Leaf
            }
            """;

        ImmutableArray<Diagnostic> chainDiagnostics = RunGsAnalyzer(analyzerDll, ChainGsSource);
        ImmutableArray<Diagnostic> mixedDiagnostics = RunGsAnalyzer(analyzerDll, MixedGsSource);

        Assert.Equal(roslynChainIds.Count, chainDiagnostics.Length); // Row 3: G# also fires exactly once, not twice.
        Assert.Equal(roslynMixedIds.Count, mixedDiagnostics.Length); // Row 5: G# also fires zero times, not once.
    }

    // Analyzer D (recursive chain walk, I4's ConditionalAccessExpressionSyntax
    // case): `x.WhenNotNull is ConditionalAccessExpressionSyntax nested` —
    // walks to the FURTHER null-conditional operator in the same chain.
    // Reports once per chain by only firing on the node whose WhenNotNull IS
    // a nested CAE (i.e. every node except the last).
    private const string RecursiveChainWalkAnalyzerSource = @"
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
        ""TEST4173D"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private const string RecursiveChainWalkCorpus = @"
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Chain(Box box) => box?.Next?.Next?.Leaf; }
";

    /// <summary>
    /// A three-level chain <c>a?.b?.c?.d</c> has two operators whose
    /// <c>WhenNotNull</c> is itself another <c>ConditionalAccessExpressionSyntax</c>
    /// (every operator except the last) — Roslyn fires twice, and the
    /// translated analyzer (via <c>NullConditionalChain.NextNullConditionalHop</c>)
    /// must match exactly, proving the recursive-chain-walk idiom (I4's third
    /// case) is chain-safe rather than merely single-hop-safe.
    /// </summary>
    [Fact]
    public void RecursiveChainWalkTest_MatchesRoslyn_OnThreeLevelChain()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(RecursiveChainWalkAnalyzerSource, "RecursiveChainWalkAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, RecursiveChainWalkCorpus, "TEST4173D");
        Assert.Equal(new[] { "TEST4173D", "TEST4173D" }, roslynIds);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, RecursiveChainWalkAnalyzerSource, "TranslatedRecursiveChainWalk");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string GsSource = """
            package sample

            class Leaf(Value string) { }
            class Box(Next Box?, Leaf Leaf?) { }

            func Chain(box Box?) Leaf?
            {
                return box?.Next?.Next?.Leaf
            }
            """;

        ImmutableArray<Diagnostic> diagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Equal(roslynIds.Count, diagnostics.Length);
        Assert.Equal(2, diagnostics.Select(d => d.Location.Span).Distinct().Count());
    }

    // `.WhenNotNull` read as a bare VALUE (not consumed by another is-pattern
    // scrutinee I4 intercepts) has no G# counterpart and must stay a loud
    // CS2GS-GAP — I4 only intercepts `.WhenNotNull` in SCRUTINEE position.
    private const string BareWhenNotNullValueAnalyzerSource = @"
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
        ""TEST4173BARE"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// <c>.WhenNotNull</c> read into a LOCAL (not tested by an <c>is</c>
    /// pattern I4 can intercept) has no G# counterpart and correctly has
    /// none — same category as the already-unmapped
    /// <c>AssignmentExpressionSyntax.Left</c>. Must surface a loud
    /// CS2GS-GAP at translate time, never a silent wrong answer.
    /// </summary>
    [Fact]
    public void BareWhenNotNullValueRead_IsALoudGap()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(BareWhenNotNullValueAnalyzerSource);

        // The falsifier: `.WhenNotNull` really did survive untranslated (it
        // was not silently dropped or renamed), so the bind failure below is
        // a real one, not a vacuous pass.
        Assert.Contains(".WhenNotNull", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        IReadOnlyList<string> errors = TryGetBindErrors(printed);
        Assert.NotEmpty(errors);
        Assert.Contains(errors, e => e.Contains("WhenNotNull", StringComparison.Ordinal));
    }

    // A registration combining ConditionalAccessExpression with another kind
    // in the SAME call: the guard would wrongly reject the other kind's
    // nodes, so this must be a loud gap rather than a silently wrong guard.
    private const string MultiKindRegistrationAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class MultiKindRegistrationAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST4173E"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression, SyntaxKind.SimpleMemberAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
        => context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
}
";

    /// <summary>
    /// A multi-kind registration naming <c>ConditionalAccessExpression</c>
    /// alongside another kind is a loud gap: the wrapper guard the single-kind
    /// case uses would incorrectly also reject the other kind's dispatch.
    /// </summary>
    [Fact]
    public void MultiKindRegistration_IsALoudGapRatherThanAWrongGuard()
    {
        (_, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(MultiKindRegistrationAnalyzerSource);

        TranslationDiagnostic gap = Assert.Single(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("RegisterSyntaxNodeAction", gap.Message, StringComparison.Ordinal);
    }

    // Analyzer H (cast handler, I7): a BARE `context.Node is ConditionalAccessExpressionSyntax`
    // with NO designator — the commonest real-world spelling of a type probe.
    // This parses as the classic BinaryExpressionSyntax/IsExpression node,
    // not a pattern, so it exercises a SEPARATE cs2gs entry point than every
    // designated `is Type x` form the rest of this file uses. Without I1
    // reaching this shape too, I7's deliberately non-discriminating
    // ConditionalAccessExpressionSyntax -> ExpressionSyntax map row would let
    // this test vacuously (over-)match every ordinary access as well.
    private const string BareCastHandlerAnalyzerSource = @"
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
        ""TEST4173H"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// The bare (undesignated) type-test form — parsed as
    /// <c>BinaryExpressionSyntax</c>/<c>SyntaxKind.IsExpression</c>, not a
    /// pattern — must translate through the SAME <c>AsNullConditionalHop</c>
    /// rewrite as the designated form, never falling back to I7's bare
    /// non-discriminating <c>ExpressionSyntax</c> supertype (which would make
    /// this fire on every access, not just null-conditional ones).
    /// </summary>
    [Fact]
    public void BareCastHandlerTypeTest_TranslatesToAsNullConditionalHop_NotVacuousExpressionSyntax()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(BareCastHandlerAnalyzerSource);

        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, BareCastHandlerAnalyzerSource, "TranslatedBareCastHandler");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return [|box?.Name|]
            }
            """,
            new[] { "TEST4173H" });

        // The falsifier: an ORDINARY access must NOT fire (the I7-vacuous-truth repro).
        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """,
            Array.Empty<string>());
    }

    // Bare `x.Expression is ConditionalAccessExpressionSyntax` (I5's declined
    // case, undesignated form) must ALSO stay a loud gap, not fall through to
    // I7's vacuous supertype.
    private const string BareReceiverConditionalAccessAnalyzerSource = @"
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
        ""TEST4173GAP"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// I5's declined <c>.Expression is ConditionalAccessExpressionSyntax</c>
    /// case, undesignated: must surface the SAME <c>CS2GS-GAP</c> as the
    /// designated form, never a silently vacuous <c>NullConditionalReceiver(x)
    /// is ExpressionSyntax</c> (always true).
    /// </summary>
    [Fact]
    public void BareReceiverConditionalAccessTest_IsALoudGap()
    {
        (_, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(BareReceiverConditionalAccessAnalyzerSource);

        TranslationDiagnostic gap = Assert.Single(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("ConditionalAccessExpressionSyntax", gap.Message, StringComparison.Ordinal);
    }

    // Analyzer J (sibling bug #6, ordinary-access type test): a BARE
    // `node is MemberAccessExpressionSyntax` — the commonest real-world
    // spelling — registered for SimpleMemberAccessExpression.
    private const string OrdinaryMemberAccessAnalyzerSource = @"
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
        ""TEST4173J"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    // Row 15 (issue #4173 §6's critical parity check): `a?.b.c` has exactly
    // ONE genuine ordinary MemberAccessExpressionSyntax (the ".c" access —
    // ".b" is Roslyn's receiverless MemberBindingExpressionSyntax, a
    // DIFFERENT type). Before the sibling fix, G#'s unconditional
    // MemberAccessExpressionSyntax -> AccessorExpressionSyntax map row made
    // this over-fire: BOTH the ?.b hop (IsNullConditional:true) and the
    // ordinary .c hop are AccessorExpressionSyntax, so an unguarded rewrite
    // matched both.
    private const string OrdinaryMemberAccessCorpus = @"
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Mixed(Box box) => box?.Next.Leaf; }
";

    /// <summary>
    /// The sibling bug's fix, verified against real Roslyn: <c>a?.b.c</c>
    /// fires exactly once (the ordinary <c>.c</c> access), matching Roslyn's
    /// own <c>MemberAccessExpressionSyntax</c> count exactly — not twice, the
    /// pre-fix over-fire (both the <c>?.b</c> hop and the ordinary <c>.c</c>
    /// access, since the unconditional map row could not tell them apart).
    /// </summary>
    [Fact]
    public void OrdinaryMemberAccessTest_MatchesRoslyn_OnMixedChain()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(OrdinaryMemberAccessAnalyzerSource, "OrdinaryMemberAccessAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, OrdinaryMemberAccessCorpus, "TEST4173J");
        Assert.Equal(new[] { "TEST4173J" }, roslynIds); // Row 15: Roslyn fires exactly once, not twice.

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, OrdinaryMemberAccessAnalyzerSource, "TranslatedOrdinaryMemberAccess");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string GsSource = """
            package sample

            class Leaf(Value string) { }
            class Mid(Leaf Leaf, Next Mid) { }
            class Root(Mid Mid) { }

            func Mixed(root Root?) Leaf?
            {
                return root?.Mid.Leaf
            }
            """;

        ImmutableArray<Diagnostic> diagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Equal(roslynIds.Count, diagnostics.Length);
    }

    // Analyzer K (sibling bug #6, registration guard in isolation): NO inner
    // type test at all — isolates whether the REGISTRATION itself correctly
    // excludes null-conditional hops, independent of I1b's handler-level fix.
    private const string BareOrdinaryRegistrationAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BareOrdinaryRegistrationAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST4173K"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.SimpleMemberAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
        => context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
}
";

    /// <summary>
    /// With NO inner type test, only the REGISTRATION'S own guard can keep a
    /// <c>?.</c> hop out of the handler — proving I2's <c>SimpleMemberAccessExpression</c>
    /// guard is load-bearing on its own, not merely redundant with I1b's
    /// handler-level fix.
    /// </summary>
    [Fact]
    public void BareOrdinaryRegistration_FiresOnlyOnOrdinaryAccess()
    {
        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, BareOrdinaryRegistrationAnalyzerSource, "TranslatedBareOrdinaryRegistration");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return [|box.Name|]
            }
            """,
            new[] { "TEST4173K" });

        // The falsifier: a null-conditional access must NOT reach the handler.
        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.Name
            }
            """,
            Array.Empty<string>());
    }

    // Analyzer C/I3a (receiver read + Roslyn-exact span): reports at
    // `conditional.Expression.GetLocation()` — I3's NullConditionalReceiver
    // rewrite composed with I3a's ReceiverSpan location rewrite.
    private const string ReceiverLocationAnalyzerSource = @"
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
        ""TEST4173C"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// I3/I3a composed: for the FIRST (only) hop of a single-level chain, the
    /// Roslyn-exact receiver span is the receiver's own natural span (no
    /// truncation needed — nothing precedes it), so the reported location
    /// lands exactly on <c>box</c>, matching Roslyn's own
    /// <c>ConditionalAccessExpressionSyntax.Expression.GetLocation()</c>.
    /// </summary>
    [Fact]
    public void ReceiverLocationTest_TranslatesAndBindsAndFiresAtReceiver()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ReceiverLocationAnalyzerSource);
        Assert.Contains("NullConditionalChain.ReceiverSpan", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReceiverLocationAnalyzerSource, "TranslatedReceiverLocation");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return [|box|]?.Name
            }
            """,
            new[] { "TEST4173C" });
    }

    // Analyzer F (inner-hop receiver test, I5): `conditional.Expression is
    // MemberBindingExpressionSyntax` on a TWO-level chain must fire on the
    // INNER hop only (the outer hop's receiver is the plain root 'a', an
    // IdentifierNameSyntax, matching none of I5's three positive cases).
    private const string InnerHopReceiverTestAnalyzerSource = @"
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
        ""TEST4173F"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private const string InnerHopReceiverTestCorpus = @"
public class Leaf { public string Value; }
public class Box { public Box Next; public Leaf Leaf; }
public class Corpus { public static Leaf Chain(Box box) => box?.Next?.Leaf; }
";

    /// <summary>
    /// I5's <c>ReceiverIsMemberBinding</c> case, verified against real
    /// Roslyn: fires exactly once on <c>a?.b?.c</c> (the inner <c>?.c</c>
    /// hop, whose receiver continues directly off the outer <c>?.b</c> with
    /// no ordinary step in between), not on the outer hop.
    /// </summary>
    [Fact]
    public void InnerHopReceiverTest_MatchesRoslyn_OnChain()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(InnerHopReceiverTestAnalyzerSource, "InnerHopReceiverTestAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, InnerHopReceiverTestCorpus, "TEST4173F");
        Assert.Equal(new[] { "TEST4173F" }, roslynIds);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, InnerHopReceiverTestAnalyzerSource, "TranslatedInnerHopReceiverTest");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string GsSource = """
            package sample

            class Leaf(Value string) { }
            class Box(Next Box?, Leaf Leaf?) { }

            func Chain(box Box?) Leaf?
            {
                return box?.Next?.Leaf
            }
            """;

        ImmutableArray<Diagnostic> diagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Equal(roslynIds.Count, diagnostics.Length);
    }

    // Analyzer G (name extraction, I6): binds a MemberBindingExpressionSyntax
    // designator via I4, then reads its `.Name` (I6's declarative MemberMap
    // row: MemberBindingExpressionSyntax.Name -> RightPart).
    private const string NameExtractionAnalyzerSource = @"
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
        ""TEST4173G"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// I6's declarative <c>MemberBindingExpressionSyntax.Name -&gt; RightPart</c>
    /// row, composed with I4's designator binding: translates and binds
    /// cleanly, and fires once on a single-hop <c>a?.b</c>.
    /// </summary>
    [Fact]
    public void NameExtractionTest_TranslatesAndBindsAndFires()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(NameExtractionAnalyzerSource);
        Assert.Contains("RightPart", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, NameExtractionAnalyzerSource, "TranslatedNameExtraction");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(
            analyzer,
            """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.[|Name|]
            }
            """,
            new[] { "TEST4173G" });
    }

    // Analyzer I (descendant walk, I8): `.OfType<ConditionalAccessExpressionSyntax>()`
    // over `DescendantNodesAndSelf()` — must match every hop in a chain, not
    // silently over-match every ordinary access (I7's supertype risk).
    private const string DescendantWalkAnalyzerSource = @"
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
        ""TEST4173I"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// I8's <c>OfType&lt;ConditionalAccessExpressionSyntax&gt;()</c> rewrite:
    /// a two-level chain has exactly two hops, and the walk must find
    /// exactly those two — not zero (an unmapped <c>OfType</c> would be a
    /// loud gap instead) and not every ordinary access (I7's supertype risk
    /// if I8 did not re-narrow explicitly).
    /// </summary>
    [Fact]
    public void DescendantWalkTest_FindsExactlyTheChainHops()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(DescendantWalkAnalyzerSource);
        Assert.Contains("NullConditionalChain.IsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, DescendantWalkAnalyzerSource, "TranslatedDescendantWalk");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string GsSource = """
            package sample

            class Leaf(Value string) { }
            class Box(Next Box?, Leaf Leaf?) { }

            func Chain(box Box?) Leaf?
            {
                return box?.Next?.Leaf
            }

            func Plain(box Box) Box
            {
                return box.Next!!
            }
            """;

        ImmutableArray<Diagnostic> gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Equal(2, gsDiagnostics.Length);
        Assert.Equal(2, gsDiagnostics.Select(d => d.Location.Span).Distinct().Count());
    }

    /// <summary>Translates one analyzer source in ADR-0169 analyzer mode.</summary>
    /// <param name="source">The C# analyzer source.</param>
    /// <returns>The printed G# and the translation diagnostics.</returns>
    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateAnalyzerSource(
        string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Analyzer.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        LoadedDocument document = project.Documents
            .Single(d => Path.GetFileName(d.FilePath) == "Analyzer.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
        return (printed, context.Diagnostics.ToList());
    }

    /// <summary>Binds printed G# against the real GSharp.Core and returns the errors, if any.</summary>
    /// <param name="printed">The printed G# source.</param>
    /// <returns>The bind-time error messages (empty when it binds cleanly).</returns>
    private static IReadOnlyList<string> TryGetBindErrors(string printed)
    {
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "analyzer.gs"));
        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree) { IsLibrary = true };
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .Select(d => d.Id + ": " + d.Message)
            .ToList();
    }

    /// <summary>Binds printed G# against the real GSharp.Core, asserting no errors.</summary>
    /// <param name="printed">The printed G# source.</param>
    private static void AssertBinds(string printed)
    {
        IReadOnlyList<string> errors = TryGetBindErrors(printed);
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }

    /// <summary>
    /// Translates and compiles a SELF-CONTAINED analyzer source (no
    /// dependency on the real <c>src/Analyzers/InternalAnalyzers</c> files on
    /// disk — issue #4173 has no live consumer there yet) into a loadable
    /// analyzer assembly, mirroring
    /// <c>Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer</c>.
    /// </summary>
    /// <param name="workDirectory">The directory receiving the emitted dll.</param>
    /// <param name="analyzerSource">The C# analyzer source.</param>
    /// <param name="assemblyName">The emitted assembly name.</param>
    /// <returns>The analyzer assembly path.</returns>
    private static string CompileTranslatedAnalyzerFromSource(
        string workDirectory, string analyzerSource, string assemblyName)
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateAnalyzerSource(analyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "analyzer.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)));

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree)
        {
            IsLibrary = true,
            AssemblyName = assemblyName,
        };

        string dllPath = Path.Combine(workDirectory, assemblyName + ".dll");
        using (var peStream = File.Create(dllPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: assemblyName);
            Assert.True(
                result.Success,
                $"Translated {assemblyName} should compile:\n" + string.Join("\n", result.Diagnostics.Where(d => d.IsError).Select(d => d.Message)));
        }

        return dllPath;
    }

    /// <summary>
    /// Runs a translated-and-compiled analyzer over a G# source and returns
    /// the diagnostics it produces, in source order — the G# side of every
    /// Roslyn-parity assertion below (mirrors
    /// <c>Adr0169AnalyzerParityTests.TranslatedGsa0001_MatchesRoslynGsa0001_OverTranslatedCorpus</c>'s
    /// step 4, generalized to arbitrary G# source instead of a translated
    /// C# corpus).
    /// </summary>
    /// <param name="analyzerDllPath">The translated analyzer assembly.</param>
    /// <param name="gsSource">The G# source under analysis.</param>
    /// <returns>The produced diagnostics, ordered by span start.</returns>
    private static ImmutableArray<Diagnostic> RunGsAnalyzer(string analyzerDllPath, string gsSource)
    {
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(gsSource, "corpus.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n" + gsSource);

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(Array.Empty<string>());
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree) { IsLibrary = true };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + gsSource);

        return GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost.Run(compilation, new[] { analyzerDllPath })
            .OrderBy(d => d.Location.Span.Start)
            .ToImmutableArray();
    }

    /// <summary>
    /// Compiles an analyzer's OWN C# source with Roslyn and instantiates it — the
    /// Roslyn-control half of every parity assertion below, generalized from
    /// <c>Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer</c> (which reads a real
    /// file from <c>src/Analyzers/InternalAnalyzers</c>) to this file's synthetic,
    /// self-contained analyzer sources (issue #4173 has no real repo consumer to read from).
    /// </summary>
    /// <param name="analyzerSource">The C# analyzer source, declaring a type in namespace <c>Sample</c>.</param>
    /// <param name="analyzerTypeName">The analyzer type's simple name.</param>
    /// <returns>A live Roslyn analyzer instance.</returns>
    private static RoslynDiagnosticAnalyzer CompileRoslynAnalyzerFromSource(string analyzerSource, string analyzerTypeName)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Analyzer.cs", analyzerSource) });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emitResult = project.Compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            $"Roslyn control analyzer {analyzerTypeName} should compile:\n"
                + string.Join("\n", emitResult.Diagnostics.Where(d => d.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error)));

        Assembly assembly = Assembly.Load(peStream.ToArray());
        Type analyzerType = assembly.GetType("Sample." + analyzerTypeName, throwOnError: true);
        return (RoslynDiagnosticAnalyzer)Activator.CreateInstance(analyzerType);
    }

    /// <summary>
    /// Runs a live Roslyn analyzer over a C# corpus and returns the diagnostics
    /// it produces with <paramref name="diagnosticId"/>, in source order — the
    /// Roslyn-control side of every parity assertion below (mirrors
    /// <c>Adr0169AnalyzerParityTests.RunRoslynAnalyzer</c>).
    /// </summary>
    /// <param name="analyzer">The Roslyn analyzer.</param>
    /// <param name="corpusSource">The C# corpus source.</param>
    /// <param name="diagnosticId">The diagnostic id to keep.</param>
    /// <returns>The matching diagnostic ids, in source order.</returns>
    private static IReadOnlyList<string> RunRoslynAnalyzer(RoslynDiagnosticAnalyzer analyzer, string corpusSource, string diagnosticId)
    {
        LoadedCSharpProject corpus = CSharpProjectLoader.LoadInMemory(new[] { ("Corpus.cs", corpusSource) });
        Assert.True(corpus.BoundWithoutErrors, string.Join("\n", corpus.ErrorDiagnostics));

        var withAnalyzers = corpus.Compilation.WithAnalyzers(ImmutableArray.Create(analyzer));
        return withAnalyzers.GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult()
            .Where(d => d.Id == diagnosticId)
            .OrderBy(d => d.Location.SourceSpan.Start)
            .Select(d => d.Id)
            .ToList();
    }
}
