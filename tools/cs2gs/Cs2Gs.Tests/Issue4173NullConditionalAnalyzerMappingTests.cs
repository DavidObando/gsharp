// <copyright file="Issue4173NullConditionalAnalyzerMappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using Xunit;

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
/// <item><c>x.WhenNotNull is MemberBindingExpressionSyntax</c> (proving a
/// single-hop access) → dropped, with a later <c>x.Expression</c> read
/// becoming <c>x.LeftPart</c>.</item>
/// </list>
/// <c>MemberBindingExpressionSyntax</c>/<c>ElementBindingExpressionSyntax</c>
/// deliberately stay unmapped — a direct reference is a loud gap, not a bug.
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

        Assert.Contains("IsNullConditional", printed, StringComparison.Ordinal);
        Assert.Contains("AccessorExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ConditionalAccessExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);
    }

    // A single-hop analyzer idiom: `x.WhenNotNull is MemberBindingExpressionSyntax`
    // proves (from the analyzer's own source) that `x.Expression` is safe to
    // read as G#'s `.LeftPart`.
    private const string SingleHopExpressionAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SingleHopExpressionAnalyzer : DiagnosticAnalyzer
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
            context.ReportDiagnostic(Diagnostic.Create(Rule, conditional.Expression.GetLocation()));
        }
    }
}
";

    /// <summary>
    /// The single-hop conjunction idiom: <c>.WhenNotNull is
    /// MemberBindingExpressionSyntax</c> proves single-hop and disappears
    /// (G#'s left-hand <c>IsNullConditional</c> test already establishes the
    /// same fact), and the companion <c>.Expression</c> read becomes
    /// <c>.LeftPart</c> — never left as an unmapped, unbindable member name.
    /// </summary>
    [Fact]
    public void SingleHopConjunction_WhenNotNullDropsAndExpressionBecomesLeftPart()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(SingleHopExpressionAnalyzerSource);

        Assert.Contains(".LeftPart", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".WhenNotNull", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Expression", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("MemberBindingExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);
    }

    // The chain-shaped companion test: `x.WhenNotNull is ConditionalAccessExpressionSyntax`
    // does NOT prove single-hop (a chain's WhenNotNull is itself nested), so
    // the conjunction idiom must not fire, and `.Expression` must not be
    // silently renamed to `.LeftPart` (wrong for a chain — see issue history).
    private const string ChainedWhenNotNullAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ChainedWhenNotNullAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST4173C"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.WhenNotNull is ConditionalAccessExpressionSyntax)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, conditional.Expression.GetLocation()));
        }
    }
}
";

    /// <summary>
    /// The chain case must fail LOUDLY, never silently: with no companion
    /// proof of single-hop-ness, <c>.Expression</c> has no safe G#
    /// counterpart (a chain's Roslyn <c>.Expression</c> is the chain's
    /// ultimate root, not the immediate <c>.LeftPart</c> subtree) and is left
    /// as an unmapped identity member name, which the round-trip binder then
    /// rejects — this is the file's documented backstop (never a silent
    /// wrong answer).
    /// </summary>
    [Fact]
    public void ChainedWhenNotNullAccess_IsALoudGapRatherThanASilentMismap()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ChainedWhenNotNullAnalyzerSource);

        // The falsifier: the single-hop idiom really did NOT fire here (it
        // would have dropped both the WhenNotNull test and the member name),
        // so this loud failure is a real one, not a vacuous pass.
        Assert.Contains(".Expression", printed, StringComparison.Ordinal);

        IReadOnlyList<string> errors = TryGetBindErrors(printed);
        Assert.NotEmpty(errors);
        Assert.Contains(errors, e => e.Contains("Expression", StringComparison.Ordinal));
    }

    // A direct reference to MemberBindingExpressionSyntax OUTSIDE the two
    // idiom patterns above — this must stay a loud CS2GS-GAP forever, never
    // get "fixed" into a fake mapping by a future well-meaning contributor.
    private const string DirectMemberBindingReferenceAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class DirectMemberBindingReferenceAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST4173D"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ConditionalAccessExpression);

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        if (context.Node is ConditionalAccessExpressionSyntax conditional
            && conditional.WhenNotNull is MemberBindingExpressionSyntax binding)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, binding.GetLocation()));
        }
    }
}
";

    /// <summary>
    /// <c>MemberBindingExpressionSyntax</c> has no G# counterpart and
    /// correctly has none — same category as the already-unmapped
    /// <c>AssignmentExpressionSyntax.Left</c>. A direct type reference to it
    /// (here, a designation binding it to a local) must surface a loud
    /// CS2GS-GAP at translate time.
    /// </summary>
    [Fact]
    public void DirectMemberBindingExpressionSyntaxReference_IsALoudGap()
    {
        (_, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(DirectMemberBindingReferenceAnalyzerSource);

        TranslationDiagnostic gap = Assert.Single(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("MemberBindingExpressionSyntax", gap.Message, StringComparison.Ordinal);
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
}
