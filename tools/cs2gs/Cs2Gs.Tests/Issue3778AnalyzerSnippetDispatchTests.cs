// <copyright file="Issue3778AnalyzerSnippetDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 M5 second half / issue #3778: <c>SnippetTranslator</c> existed and
/// was unit-tested, but nothing DISPATCHED it during a migration, so migrated
/// analyzer tests handed C# snippets to a verifier that compiles G#. Covered
/// here: the dispatch rule (what is and is not a snippet), the two real shapes
/// — a snippet arriving through a local, and a snippet composed with <c>+</c>
/// out of a shared model — and marker fidelity, which is the part that can
/// make a migrated test pass for the wrong reason.
/// </summary>
public class Issue3778AnalyzerSnippetDispatchTests
{
    /// <summary>
    /// The harness shape the detector keys on (a static method taking an
    /// analyzer and a source string), trimmed to what dispatch needs.
    /// </summary>
    private const string HarnessSource = @"
using System.Threading.Tasks;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample.Tests;

internal static class AnalyzerTestHelper
{
    public static Task AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer, string source, params string[] diagnosticIds)
        => Task.CompletedTask;
}
";

    private const string AnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SampleAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST0001"",
        ""Title"",
        ""Message"",
        ""Testing"",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(
            c => c.ReportDiagnostic(Diagnostic.Create(Rule, c.Node.GetLocation())),
            SyntaxKind.ElementAccessExpression);
    }
}
";

    /// <summary>
    /// Shape 1 of #3778: the snippet is not a literal at the call site, it is
    /// the initializer of a <c>const string</c> LOCAL that is passed to the
    /// harness on the next statement. The design #3777 shipped assumed a
    /// literal argument and therefore never fired.
    /// </summary>
    [Fact]
    public void SnippetReachingTheHarnessThroughALocal_IsTranslated()
    {
        string printed = TranslateTests(@"
namespace Sample.Tests.Cases;

public sealed class Tests
{
    public System.Threading.Tasks.Task Reports()
    {
        const string Source = ""class C { void M(int[] a) { var x = a[0]; } }"";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, ""TEST0001"");
    }
}
");

        // The G# spelling, not the C# one: a G# `func` with G# parameter order.
        Assert.Contains("func M(a []int32)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("void M(int[] a)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Shape 2 of #3778: the snippet is COMPOSED — a shared <c>const string</c>
    /// model plus a per-test literal. Neither operand is a compilable unit, so
    /// the translatable thing is the concatenation. The migrated test carries
    /// the folded whole and loses the shared-model factoring; that is the
    /// trade, and this test pins it.
    /// </summary>
    [Fact]
    public void ComposedSnippet_IsTranslatedAsOneFoldedUnit()
    {
        string printed = TranslateTests(@"
namespace Sample.Tests.Cases;

public sealed class Tests
{
    private const string Model = ""class Node { public int[] Values; }\n"";

    public System.Threading.Tasks.Task Reports()
    {
        string source = Model + ""class C { void M(Node n) { var x = n.Values[0]; } }"";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), source, ""TEST0001"");
    }
}
");

        // Both halves are present in ONE translated unit, in G# spelling.
        Assert.Contains("class Node", printed, StringComparison.Ordinal);
        Assert.Contains("func M(n Node)", printed, StringComparison.Ordinal);

        // The composition is gone: the initializer is a single literal, so
        // there is no residual `Model + ` concatenation at the use site.
        Assert.DoesNotContain("Model +", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The guard that makes the rule safe. Silently rewriting a string that was
    /// never a snippet is the bad failure mode, so a constant string that does
    /// NOT reach a harness source parameter must survive verbatim — even in the
    /// same class, even when it is valid C# source text.
    /// </summary>
    [Fact]
    public void ConstantStringThatNeverReachesTheHarness_IsLeftAlone()
    {
        string printed = TranslateTests(@"
namespace Sample.Tests.Cases;

public sealed class Tests
{
    public string Unrelated()
    {
        const string NotASnippet = ""class C { void M(int[] a) { var x = a[0]; } }"";
        return NotASnippet;
    }

    public System.Threading.Tasks.Task Reports()
    {
        const string Source = ""class D { void M(int[] a) { var x = a[0]; } }"";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, ""TEST0001"");
    }
}
");

        // Untouched, C# text and all.
        Assert.Contains(
            "class C { void M(int[] a) { var x = a[0]; } }",
            printed,
            StringComparison.Ordinal);

        // …while the one that DOES reach the harness was translated. Both
        // halves in one assertion pair: if dispatch stopped firing altogether
        // the first assertion would still hold, so this one is the anti-vacuity
        // guard for it.
        Assert.Contains("class D", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("class D { void M(int[] a)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Marker fidelity, the crux. The original re-placement rule searched
    /// forward from the previous marker, so a marked name that also occurs
    /// EARLIER in the unit bracketed the wrong declaration — exactly what a
    /// composed snippet produces, because the shared model declares the method
    /// the per-test override re-declares. The rule is now positional: the Nth
    /// occurrence in the C# is the Nth occurrence in the G#.
    /// </summary>
    [Fact]
    public void MarkerOnALaterOccurrence_StaysOnThatOccurrence()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(@"
class Base
{
    public virtual int Rewrite() => 0;
}

class Derived : Base
{
    public override int [|Rewrite|]() => 1;
}
");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);

        int markerIndex = result.GsWithMarkers.IndexOf("[|Rewrite|]", StringComparison.Ordinal);
        int derivedIndex = result.GsWithMarkers.IndexOf("class Derived", StringComparison.Ordinal);
        Assert.True(markerIndex > 0, "the marker must be placed: " + result.GsWithMarkers);
        Assert.True(
            markerIndex > derivedIndex,
            "the marker must bracket Derived.Rewrite, not Base.Rewrite: " + result.GsWithMarkers);
    }

    /// <summary>
    /// The other half of marker fidelity: a marked text that does NOT survive
    /// translation is dropped and reported, never silently re-placed somewhere
    /// plausible. The migrated test then fails on a marker/id count mismatch,
    /// which is loud, rather than asserting the wrong span.
    /// </summary>
    [Fact]
    public void MarkerWhoseTextDoesNotSurvive_IsDroppedAndReported()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(@"
class Holder
{
    object Box(int value) => [|(object)value|];
}
");

        Assert.Single(result.UnplacedMarkers);
        Assert.Contains(
            result.Diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId);
        Assert.DoesNotContain("[|", result.GsWithMarkers, StringComparison.Ordinal);
    }

    /// <summary>
    /// A C# snippet spanning several namespaces cannot become one G# unit — G#
    /// declares one package per compilation unit — so the declarations collapse
    /// into the first namespace and a namespace-scoped rule then fires, or
    /// fails to fire, on the wrong ones. Left unfixed (it needs a multi-unit
    /// verifier), but it must be REPORTED: a negative test that passes because
    /// its subject moved namespace is passing for the wrong reason.
    /// </summary>
    [Fact]
    public void MultiNamespaceSnippet_ReportsTheCollapse()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(@"
namespace One
{
    class A { }
}

namespace Two
{
    class B { }
}
");

        Assert.NotNull(result.GsWithMarkers);
        Assert.Contains(
            result.Diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
                && d.Message.Contains("collapse", StringComparison.Ordinal));

        // …and the collapse is real, so the report is not decorative.
        Assert.Equal(
            1,
            result.GsWithMarkers.Split("package ", StringSplitOptions.None).Length - 1);
    }

    /// <summary>
    /// Translates a two-file analyzer TEST project (harness + cases) in
    /// analyzer mode with the snippet translator wired in, exactly as
    /// <c>TranslateStage</c> does, and returns the printed cases file.
    /// </summary>
    /// <param name="testsSource">The C# test-case source.</param>
    /// <returns>The printed G#.</returns>
    private static string TranslateTests(string testsSource)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Harness.cs", HarnessSource), ("Analyzer.cs", AnalyzerSource), ("Tests.cs", testsSource) });
        Assert.True(
            project.BoundWithoutErrors,
            "Fixture should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) == "Tests.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        {
            TranslateAnalyzerSnippet = SnippetTranslator.Translate,
        };
        CompilationUnit unit = translator.TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
