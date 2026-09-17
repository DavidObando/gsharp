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
using Cs2Gs.Translator.Analyzers;
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
    private const string Round3NotDesignatedAnalyzerSource = @"
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
        ""TEST4173R3A"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private const string Round3PlainAccessCorpus = @"
public class Box { public string Name; }
public class Corpus { public static string Get(Box box) => box.Name; }
";

    /// <summary>
    /// The round-2 reviewer's exact counterexample, verified against BOTH
    /// real Roslyn and the translated analyzer: plain (non-null-conditional)
    /// member access must yield ZERO diagnostics, not the pre-round-3 over-
    /// match of 2. Also asserts the printed G# carries the sound
    /// <c>AsNullConditionalHop</c> predicate rewrite, never a bare (and
    /// therefore vacuously-true-on-anything) <c>is not ExpressionSyntax</c>.
    /// </summary>
    [Fact]
    public void ReviewerCounterexample_NegatedDesignatedConditionalAccess_MatchesRoslyn_OnPlainAccess()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(Round3NotDesignatedAnalyzerSource, "Round3NotDesignatedAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TEST4173R3A");
        Assert.Empty(roslynIds); // Real Roslyn: zero. The pre-round-3 bug reported 2 here.

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3NotDesignatedAnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("is not ExpressionSyntax", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, Round3NotDesignatedAnalyzerSource, "TranslatedRound3NotDesignated");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string GsSource = """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """;

        ImmutableArray<Diagnostic> gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Empty(gsDiagnostics); // G#: zero, matching Roslyn.
    }

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
    private const string Round3PositiveDesignatedAnalyzerSource = @"
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
        ""TEST4173R3I"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// Positive counterpart of <see cref="ReviewerCounterexample_NegatedDesignatedConditionalAccess_MatchesRoslyn_OnPlainAccess"/>:
    /// translates soundly and binds — the key risk this test targets is the
    /// STATEMENT-form positive designated pattern being claimed by the
    /// `if let`/positive-guard-hoist machinery (which used to reach
    /// MapTypeSyntax directly) before TranslateIsPattern's own analyzer-idiom
    /// entry point runs. Also verified against real Roslyn on the null-
    /// conditional corpus (zero-vs-nonzero — not an exact execution-count
    /// comparison: G# dispatches its folded member-access NAME token to the
    /// same registration as its receiver, an orthogonal representational
    /// difference unrelated to this fix, same as
    /// <see cref="OrCombinatorConditionalAccess_TranslatesBothLeavesSoundly"/>'s note).
    /// </summary>
    [Fact]
    public void PositiveDesignatedConditionalAccess_MatchesRoslyn_OnBothShapes()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer = CompileRoslynAnalyzerFromSource(
            Round3PositiveDesignatedAnalyzerSource, "Round3PositiveDesignatedAnalyzer");
        IReadOnlyList<string> roslynConditionalIds =
            RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"), "TEST4173R3I");
        IReadOnlyList<string> roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TEST4173R3I");
        Assert.Single(roslynConditionalIds);
        Assert.Empty(roslynPlainIds);

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3PositiveDesignatedAnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, Round3PositiveDesignatedAnalyzerSource, "TranslatedRound3PositiveDesignated");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        ImmutableArray<Diagnostic> conditionalDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.Name
            }
            """);
        ImmutableArray<Diagnostic> plainDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """);

        Assert.NotEmpty(conditionalDiagnostics); // Fires on the null-conditional access (like Roslyn).
        Assert.Empty(plainDiagnostics); // Stays silent on plain access (like Roslyn) — the over-match this round fixes.
    }

    // The `or` combinator (bare, no designator): `is ConditionalAccessExpressionSyntax
    // or MemberAccessExpressionSyntax` — ONE combinator exercising BOTH of
    // §4.1's shared-node leaf fixes at once. IsNativelyExpressiblePattern
    // refuses the whole pattern (it mentions CAE), routing to the legacy
    // boolean lowering, where the `or` combinator's own `||` composition
    // (TranslatePatternTest's BinaryPatternSyntax case) is untouched — no
    // bespoke `or`-handling needed for CAE at all, proving the leaf-level fix
    // composes for free.
    private const string Round3OrCombinatorAnalyzerSource = @"
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
        ""TEST4173R3B"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// A bare (undesignated) <c>or</c> combinator over two shared-node types
    /// (CAE and MemberAccessExpressionSyntax) — proves
    /// <c>PatternMentionsConditionalAccessType</c>'s refusal in
    /// <c>IsNativelyExpressiblePattern</c> correctly diverts the WHOLE pattern
    /// (not just the CAE leaf) to boolean lowering, and that lowering's
    /// existing <c>||</c> composition needs no CAE-specific code at all — both
    /// leaves get their own discriminator/predicate rewrite exactly as if
    /// each stood alone. (A full Roslyn-vs-G# execution parity check is not
    /// meaningful here: G# folds a member-access NAME token onto the SAME
    /// right-nested node its receiver hop does, so <c>.Parent</c>-based
    /// traversal counts do not correspond 1:1 with Roslyn's
    /// <c>MemberBindingExpressionSyntax</c>-vs-<c>IdentifierNameSyntax</c>
    /// split — an orthogonal representational difference, not a soundness
    /// gap in this fix. Translation soundness is what §4.2 promises here.)
    /// </summary>
    [Fact]
    public void OrCombinatorConditionalAccess_TranslatesBothLeavesSoundly()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3OrCombinatorAnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.Contains("AccessorExpressionSyntax { IsNullConditional: false }", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, Round3OrCombinatorAnalyzerSource, "TranslatedRound3OrCombinator");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        Assert.Single(analyzers);
    }

    // The `and` combinator with a designator: `is ConditionalAccessExpressionSyntax
    // cae and not null`. GS0390/CS8780 permit a designator under `and` — the
    // CAE leaf binds by substitution (§4.2(d)), and the designator must be
    // usable AFTER the whole `and` test (`cae.GetLocation()` below). The
    // second conjunct (`not null`) is trivially true whenever the CAE
    // predicate already matched (a CAE-typed value is never null once
    // AsNullConditionalHop proves it IS the hop) — deliberately: it exercises
    // the BinaryPatternSyntax "and" composition path itself, not any
    // CAE-specific member (CAE has no G# member surface to test against).
    private const string Round3AndCombinatorAnalyzerSource = @"
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
        ""TEST4173R3C"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// A designator under the <c>and</c> combinator — the one non-top-level
    /// position C#/G# both allow one (GS0390) — must bind and the second
    /// conjunct must still evaluate (here always true, so this behaves
    /// identically to the bare designated form, but exercises the `and`
    /// composition path instead of the top-level I1 shortcut).
    /// </summary>
    [Fact]
    public void AndCombinatorConditionalAccess_MatchesRoslyn_OnMixedAccess()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(Round3AndCombinatorAnalyzerSource, "Round3AndCombinatorAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, OrdinaryMemberAccessCorpus, "TEST4173R3C");

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3AndCombinatorAnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, Round3AndCombinatorAnalyzerSource, "TranslatedRound3AndCombinator");
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

        ImmutableArray<Diagnostic> gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Equal(roslynIds.Count, gsDiagnostics.Length);
    }

    // A CAE-mentioning pattern used as a SWITCH-CASE label: no sound G#
    // pattern exists for it (§4.3) — must be a loud CS2GS-GAP, not a silent
    // fallback to the non-discriminating ExpressionSyntax supertype.
    private const string Round3SwitchLabelAnalyzerSource = @"
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
        ""TEST4173R3D"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// §4.3: a switch-case label is a GPattern-only position — CAE's faithful
    /// G# form is a predicate, not a node type, so this MUST surface a loud
    /// <c>CS2GS-GAP</c>, never a silent (and unsound) fallback.
    /// </summary>
    [Fact]
    public void SwitchLabelConditionalAccess_IsALoudGap()
    {
        (_, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3SwitchLabelAnalyzerSource);

        TranslationDiagnostic gap = Assert.Single(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId);
        Assert.Contains("ConditionalAccessExpressionSyntax", gap.Message, StringComparison.Ordinal);
    }

    // A CAE-mentioning pattern used as a SWITCH-EXPRESSION arm: same gap as
    // the switch-case-label form above, different C# syntax.
    private const string Round3SwitchExpressionArmAnalyzerSource = @"
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
        ""TEST4173R3E"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// §4.3's switch-EXPRESSION-arm sibling of <see cref="SwitchLabelConditionalAccess_IsALoudGap"/>.
    /// </summary>
    [Fact]
    public void SwitchExpressionArmConditionalAccess_IsALoudGap()
    {
        (_, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3SwitchExpressionArmAnalyzerSource);

        TranslationDiagnostic gap = Assert.Single(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId);
        Assert.Contains("ConditionalAccessExpressionSyntax", gap.Message, StringComparison.Ordinal);
    }

    // The nested-property-subpattern shape (§4.2(c)) that reaches
    // TranslatePatternTest with receiverSyntax == null (via AddTypedSubpatternTest,
    // which never passes it): a real, valid Roslyn shape reachable only through
    // a PARENTHESIZED chain break (`(a?.b)?.c`) — the ONE place Roslyn allows a
    // bare CAE to sit inside another node's typed property (ParenthesizedExpressionSyntax.Expression).
    private const string Round3NestedSubpatternAnalyzerSource = @"
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
        ""TEST4173R3F"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    /// <summary>
    /// §4.2(c), the critical CAN'T-SKIP case: a nested property subpattern
    /// (<c>ParenthesizedExpressionSyntax { Expression: ConditionalAccessExpressionSyntax
    /// cae }</c>) reaches the leaf hook through <c>AddTypedSubpatternTest</c>,
    /// which calls <c>TranslatePatternTest</c> WITHOUT a <c>receiverSyntax</c>
    /// (it defaults to null). If the CAE hook were gated on
    /// <c>receiverSyntax != null</c>, this shape would silently mishandle —
    /// reintroducing the exact bug class round 3 fixes. This must translate
    /// without throwing, bind, and match real Roslyn on a genuine
    /// parenthesized chain-break corpus.
    /// </summary>
    [Fact]
    public void NestedSubpatternConditionalAccess_MatchesRoslyn_WithNullReceiverSyntax()
    {
        const string Corpus = @"
public class Box { public Box? Next; public string? Value; }
public class Corpus { public static string? Get(Box? a) => (a?.Next)?.Value; }
";
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(Round3NestedSubpatternAnalyzerSource, "Round3NestedSubpatternAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, Corpus, "TEST4173R3F");
        Assert.Single(roslynIds); // The one parenthesized chain-break: (a?.Next).

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3NestedSubpatternAnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        AssertBinds(printed);
    }

    // The previously-unreported ElementAccessExpressionSyntax sibling of the
    // real-repo tier-1 switch-label bug (RewriterClonePreservationAnalyzer.cs:334),
    // modeled directly on that real shape.
    private const string Round3ElementAccessSwitchLabelAnalyzerSource = @"
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
        ""TEST4173R3G"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private const string Round3ElementAccessSwitchLabelCorpus = @"
public class Box { public string this[int i] => """"; }
public class Corpus
{
    public static string Plain(Box box) => box[0];
    public static string? Conditional(Box? box) => box?[0];
}
";

    /// <summary>
    /// The ElementAccessExpressionSyntax sibling of the tier-1 switch-label
    /// bug (row 15's MemberAccessExpressionSyntax case, here as a genuine
    /// switch-case label instead of an is-pattern). Roslyn NEVER sees
    /// <c>box?[0]</c> as <c>ElementAccessExpressionSyntax</c> at all (it is
    /// <c>ElementBindingExpressionSyntax</c>, a different kind), so real
    /// Roslyn's own count is 1 (only <c>box[0]</c>) no matter how the
    /// analyzer is written — but G# folds BOTH onto the SAME
    /// <c>IndexExpressionSyntax</c> node, distinguished only by
    /// <c>IsNullConditional</c>. Without the round-3 discriminator, the
    /// translated switch-case label would over-match to 2; the fix keeps it
    /// at 1, matching Roslyn.
    /// </summary>
    [Fact]
    public void SwitchLabelElementAccess_MatchesRoslyn_OnMixedAccess()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer = CompileRoslynAnalyzerFromSource(
            Round3ElementAccessSwitchLabelAnalyzerSource, "Round3ElementAccessSwitchLabelAnalyzer");
        IReadOnlyList<string> roslynIds =
            RunRoslynAnalyzer(roslynAnalyzer, Round3ElementAccessSwitchLabelCorpus, "TEST4173R3G");
        Assert.Single(roslynIds); // Only box[0]; box?[0] is ElementBindingExpressionSyntax to Roslyn.

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(Round3ElementAccessSwitchLabelAnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("IndexExpressionSyntax { IsNullConditional: false }", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, Round3ElementAccessSwitchLabelAnalyzerSource, "TranslatedRound3ElementAccessSwitchLabel");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        const string GsSource = """
            package sample

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
            }
            """;

        ImmutableArray<Diagnostic> gsDiagnostics = RunGsAnalyzer(analyzerDll, GsSource);
        Assert.Equal(roslynIds.Count, gsDiagnostics.Length); // G# also fires exactly once, not twice (the pre-fix over-match).
    }

    /// <summary>
    /// Regression for the "preserved ordering" concern: none of the tier-1
    /// leaf swaps disturb <c>TryTranslateAnalyzerBaseCallCheck</c>, which must
    /// still run FIRST (it is called at the head of <c>TranslateIsPattern</c>,
    /// before any generic pattern translation).
    /// </summary>
    [Fact]
    public void BaseCallCheck_StillTranslatesToBaseClassCallExpressionSyntax()
    {
        const string AnalyzerSource = @"
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
        ""TEST4173R3H"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateAnalyzerSource(AnalyzerSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("invocation.Parent is BaseClassCallExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("AccessorExpressionSyntax", printed, StringComparison.Ordinal);
        AssertBinds(printed);
    }

    /// <summary>
    /// §4.5 drift test: the translator's own shared-node registry
    /// (<c>PlainAccessAnalyzerTypes</c> + <c>ConditionalAccessTypeName</c>,
    /// exposed via <see cref="CSharpToGSharpTranslator.EnumerateAnalyzerSharedGsNodeTypeNames"/>)
    /// must agree EXACTLY with <see cref="RoslynAnalyzerApiMap"/>'s own
    /// <c>SharedGsNode</c>-flagged rows — if a future contributor adds a
    /// fourth shared-node map row and forgets to flag it (or vice versa),
    /// this test fails instead of silently shipping the over-match bug a
    /// fourth time.
    /// </summary>
    [Fact]
    public void SharedGsNodeRegistry_AgreesWithRoslynAnalyzerApiMap()
    {
        var expected = new HashSet<string>(StringComparer.Ordinal)
        {
            "Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax",
            "Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax",
            "Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalAccessExpressionSyntax",
        };

        var translatorRegistry = new HashSet<string>(
            CSharpToGSharpTranslator.EnumerateAnalyzerSharedGsNodeTypeNames(), StringComparer.Ordinal);
        var mapRegistry = new HashSet<string>(
            RoslynAnalyzerApiMap.EnumerateSharedGsNodeTypeNames(), StringComparer.Ordinal);

        Assert.Equal(expected, translatorRegistry);
        Assert.Equal(expected, mapRegistry);
    }

    // =======================================================================
    // ADVERSARIAL REVIEW (round 3, not part of the implementer's own test
    // suite) — independent guard-hoist stress tests. Scratch, temporary.
    // =======================================================================

    // Positive guard-hoist (no early exit; TryBuildPositiveGuardHoist /
    // TryBuildIfLetGuard) over a PLAIN-ACCESS shared-node type
    // (MemberAccessExpressionSyntax), exercising the newly-added
    // `!t.IsNullConditional` guard conjunct rather than CAE's predicate swap.
    private const string ReviewPositivePlainAccessSource = @"
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
        ""TESTREV1"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    [Fact]
    public void Review_PositiveGuardHoist_PlainAccessType_MatchesRoslyn()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(ReviewPositivePlainAccessSource, "ReviewPositivePlainAccessAnalyzer");
        IReadOnlyList<string> roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV1");
        IReadOnlyList<string> roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer, Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"), "TESTREV1");
        Assert.NotEmpty(roslynPlainIds); // Roslyn: plain access fires (both the receiver and name identifiers' Parent is the MemberAccessExpressionSyntax).
        Assert.Empty(roslynConditionalIds); // Roslyn: null-conditional tail is MemberBindingExpressionSyntax, not MemberAccessExpressionSyntax -- zero.

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateAnalyzerSource(ReviewPositivePlainAccessSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("IsNullConditional", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReviewPositivePlainAccessSource, "ReviewPositivePlainAccess");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);

        ImmutableArray<Diagnostic> plainDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """);
        ImmutableArray<Diagnostic> conditionalDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.Name
            }
            """);

        Assert.NotEmpty(plainDiagnostics); // G#: fires on plain access, matching Roslyn.
        Assert.Empty(conditionalDiagnostics); // G#: MUST stay silent on null-conditional access, matching Roslyn.
    }

    // Negated guard-clause form (early return) over the SAME plain-access
    // type -- TryBuildNegatedGuardHoist's De Morgan `|| t.IsNullConditional`
    // addition is the part under test here.
    private const string ReviewNegatedPlainAccessSource = @"
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
        ""TESTREV2"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    [Fact]
    public void Review_NegatedGuardHoist_PlainAccessType_MatchesRoslyn()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(ReviewNegatedPlainAccessSource, "ReviewNegatedPlainAccessAnalyzer");
        IReadOnlyList<string> roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV2");
        IReadOnlyList<string> roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer, Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"), "TESTREV2");
        Assert.NotEmpty(roslynPlainIds);
        Assert.Empty(roslynConditionalIds);

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateAnalyzerSource(ReviewNegatedPlainAccessSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReviewNegatedPlainAccessSource, "ReviewNegatedPlainAccess");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);

        ImmutableArray<Diagnostic> plainDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """);
        ImmutableArray<Diagnostic> conditionalDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.Name
            }
            """);

        Assert.NotEmpty(plainDiagnostics);
        Assert.Empty(conditionalDiagnostics); // Must NOT fire on the null-conditional tail.
    }

    // Multi-condition negated guard hoist (TryBuildMultipleNegatedGuardHoists):
    // TWO negated designated patterns over TWO DIFFERENT shared-node types
    // (one CAE, one plain-access), joined by `||` in one early-return guard
    // clause, over two INDEPENDENT invocation arguments (so the two
    // conditions are independently controllable without any parenthesized-
    // chain-break trickery). This is the specific multi-condition path the
    // function name (TryBuildMultipleNegatedGuardHoists) calls out.
    private const string ReviewMultiNegatedGuardHoistSource = @"
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
        ""TESTREV3"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private const string ReviewMultiNegatedCorpus = @"
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
";

    [Fact]
    public void Review_MultipleNegatedGuardHoist_MixedSharedNodeTypes_MatchesRoslyn()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer = CompileRoslynAnalyzerFromSource(
            ReviewMultiNegatedGuardHoistSource, "ReviewMultiNegatedGuardHoistAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, ReviewMultiNegatedCorpus, "TESTREV3");
        Assert.Single(roslynIds); // Roslyn: fires exactly once, on Fires().

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ReviewMultiNegatedGuardHoistSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.Contains("IsNullConditional", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReviewMultiNegatedGuardHoistSource, "ReviewMultiNegatedGuardHoist");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);

        ImmutableArray<Diagnostic> firesDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            func frobnicate(x Box?, y Box?) { }

            class Box(Next Box?, Name string) { }

            func fires(a Box?, b Box)
            {
                frobnicate(a?.Next, b.Next)
            }
            """);
        ImmutableArray<Diagnostic> noFireArg0PlainDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            func frobnicate(x Box?, y Box?) { }

            class Box(Next Box?, Name string) { }

            func noFireArg0Plain(a Box, b Box)
            {
                frobnicate(a.Next, b.Next)
            }
            """);
        ImmutableArray<Diagnostic> noFireArg1ConditionalDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            func frobnicate(x Box?, y Box?) { }

            class Box(Next Box?, Name string) { }

            func noFireArg1Conditional(a Box?, b Box?)
            {
                frobnicate(a?.Next, b?.Next)
            }
            """);

        Assert.NotEmpty(firesDiagnostics); // G#: must fire when BOTH conditions are satisfied.
        Assert.Empty(noFireArg0PlainDiagnostics); // G#: must NOT fire when arg0 is plain (not CAE).
        Assert.Empty(noFireArg1ConditionalDiagnostics); // G#: must NOT fire when arg1 is null-conditional (not plain access).
    }

    // Independent `or`-combinator execution-parity check (item 3b): tests the
    // SOLE invocation argument directly (not via a `.Parent` traversal, which
    // is where the PR's own OrCombinator test disclaims execution parity due
    // to an orthogonal G# NAME-token dispatch difference) so an exact
    // Roslyn-vs-G# diagnostic COUNT comparison is meaningful here.
    private const string ReviewOrCombinatorArgumentSource = @"
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
        ""TESTREV5"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    private const string ReviewOrCombinatorCorpus = @"
public class Box { public Box Next; public string Name; }
public class Corpus
{
    static void Frobnicate(object x) { }
    public static void ViaConditional(Box a) => Frobnicate(a?.Next);
    public static void ViaPlain(Box a) => Frobnicate(a.Next);
    public static void ViaNeither(Box a) => Frobnicate(a);
}
";

    [Fact]
    public void Review_OrCombinator_ArgumentPosition_ExactCountMatchesRoslyn()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer =
            CompileRoslynAnalyzerFromSource(ReviewOrCombinatorArgumentSource, "ReviewOrCombinatorArgumentAnalyzer");
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer(roslynAnalyzer, ReviewOrCombinatorCorpus, "TESTREV5");
        Assert.Equal(2, roslynIds.Count); // Roslyn: fires on ViaConditional and ViaPlain, not ViaNeither.

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ReviewOrCombinatorArgumentSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        Assert.Contains("AccessorExpressionSyntax { IsNullConditional: false }", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReviewOrCombinatorArgumentSource, "ReviewOrCombinatorArgument");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);

        ImmutableArray<Diagnostic> viaConditional = RunGsAnalyzer(analyzerDll, """
            package sample

            func frobnicate(x Box?) { }

            class Box(Next Box?, Name string) { }

            func viaConditional(a Box?)
            {
                frobnicate(a?.Next)
            }
            """);
        ImmutableArray<Diagnostic> viaPlain = RunGsAnalyzer(analyzerDll, """
            package sample

            func frobnicate(x Box?) { }

            class Box(Next Box?, Name string) { }

            func viaPlain(a Box)
            {
                frobnicate(a.Next)
            }
            """);
        ImmutableArray<Diagnostic> viaNeither = RunGsAnalyzer(analyzerDll, """
            package sample

            func frobnicate(x Box?) { }

            class Box(Next Box?, Name string) { }

            func viaNeither(a Box?)
            {
                frobnicate(a)
            }
            """);

        Assert.NotEmpty(viaConditional); // G#: must fire, matching Roslyn.
        Assert.NotEmpty(viaPlain); // G#: must fire, matching Roslyn.
        Assert.Empty(viaNeither); // G#: must NOT fire, matching Roslyn.
    }

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
    private const string ReviewRecursivePatternDesignatorSource = @"
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
        ""TESTREV6"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.IdentifierName);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        // The `{ }` (empty property-pattern clause) forces RecursivePatternSyntax
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
";

    [Fact]
    public void Review_RecursivePatternDesignator_ConditionalAccessType_BindsAndMatchesRoslyn()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer = CompileRoslynAnalyzerFromSource(
            ReviewRecursivePatternDesignatorSource, "ReviewRecursivePatternDesignatorAnalyzer");
        IReadOnlyList<string> roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV6");
        IReadOnlyList<string> roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer, Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"), "TESTREV6");
        Assert.Empty(roslynPlainIds);
        Assert.Single(roslynConditionalIds);

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ReviewRecursivePatternDesignatorSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReviewRecursivePatternDesignatorSource, "ReviewRecursivePatternDesignator");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);

        ImmutableArray<Diagnostic> plainDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """);
        ImmutableArray<Diagnostic> conditionalDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.Name
            }
            """);

        Assert.Empty(plainDiagnostics); // Must not fire on plain access.
        Assert.NotEmpty(conditionalDiagnostics); // Must fire on null-conditional access, AND the designator binding used by GetLocation() must not crash/misbehave.
    }

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
    private const string ReviewRecursivePatternTernaryDesignatorSource = @"
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
        ""TESTREV7"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
";

    [Fact]
    public void Review_RecursivePatternDesignator_TernaryPosition_BindsAndMatchesRoslyn()
    {
        RoslynDiagnosticAnalyzer roslynAnalyzer = CompileRoslynAnalyzerFromSource(
            ReviewRecursivePatternTernaryDesignatorSource, "ReviewRecursivePatternTernaryDesignatorAnalyzer");
        IReadOnlyList<string> roslynPlainIds = RunRoslynAnalyzer(roslynAnalyzer, Round3PlainAccessCorpus, "TESTREV7");
        IReadOnlyList<string> roslynConditionalIds = RunRoslynAnalyzer(
            roslynAnalyzer, Round3PlainAccessCorpus.Replace("box.Name", "box?.Name"), "TESTREV7");
        Assert.Empty(roslynPlainIds);
        Assert.Single(roslynConditionalIds);

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ReviewRecursivePatternTernaryDesignatorSource);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("NullConditionalChain.AsNullConditionalHop", printed, StringComparison.Ordinal);
        AssertBinds(printed);

        string analyzerDll = CompileTranslatedAnalyzerFromSource(
            workDirectory.FullName, ReviewRecursivePatternTernaryDesignatorSource, "ReviewRecursivePatternTernaryDesignator");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);

        ImmutableArray<Diagnostic> plainDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box) string
            {
                return box.Name
            }
            """);
        ImmutableArray<Diagnostic> conditionalDiagnostics = RunGsAnalyzer(analyzerDll, """
            package sample

            class Box(Name string) { }

            func Get(box Box?) string?
            {
                return box?.Name
            }
            """);

        Assert.Empty(plainDiagnostics);
        Assert.NotEmpty(conditionalDiagnostics);
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
