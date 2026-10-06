// <copyright file="Issue3778AnalyzerSnippetDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
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
    private const string GenericStoreSnippet = """
        #nullable enable
        using System.Collections.Generic;
        namespace One
        {
            public static class C
            {
                public static void M(List<string> list)
                {
                    list.Add(Maybe());
                    list.Add(Maybe());
                }

                private static string? Maybe() => null;
            }
        }

        namespace Two
        {
            public static class C
            {
                public static void M(List<string> list)
                {
                    list.Add(Maybe());
                    list.Add(Maybe());
                }

                private static string? Maybe() => null;
            }
        }
        """;

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
    /// declares one package per compilation unit. It used to collapse into the
    /// first namespace, which made a namespace-scoped rule fire, or fail to
    /// fire, on the wrong declarations; issue #3794 splits it into one unit per
    /// package instead, and the verifier compiles the units together.
    /// </summary>
    [Fact]
    public void MultiNamespaceSnippet_SplitsIntoOneUnitPerPackage()
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

        // Issue #3794: the collapse is no longer REPORTED because it no longer
        // HAPPENS. Each declared namespace becomes its own compilation unit,
        // separated by SnippetTranslator.UnitSeparator, and the verifier
        // compiles them together — so a namespace-scoped rule still judges the
        // declarations the C# original meant.
        Assert.NotNull(result.GsWithMarkers);
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
                && d.Message.Contains("collapse", StringComparison.Ordinal));

        Assert.Equal(
            2,
            result.GsWithMarkers.Split("package ", StringSplitOptions.None).Length - 1);
        Assert.Contains("package One", result.GsWithMarkers, StringComparison.Ordinal);
        Assert.Contains("package Two", result.GsWithMarkers, StringComparison.Ordinal);
        Assert.Equal(
            2,
            result.GsWithMarkers.Split(SnippetTranslator.UnitSeparator, StringSplitOptions.None).Length);
    }

    /// <summary>
    /// Issue #4632: an <c>#if</c> inside an analyzer test snippet fails the
    /// translation like one in ordinary source. The generic snippet re-report
    /// would otherwise turn it into a non-fatal CS2GS-ANALYZER-SNIPPET warning
    /// and keep only the active arm.
    /// </summary>
    [Fact]
    public void ConditionalCompilationInASnippet_StaysATranslationError()
    {
        IReadOnlyList<TranslationDiagnostic> diagnostics = TranslateTestsDiagnostics(@"
namespace Sample.Tests.Cases;

public sealed class Tests
{
    public System.Threading.Tasks.Task Reports()
    {
        const string Source = ""class C {\n#if DEBUG\n void M() { }\n#endif\n}"";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, ""TEST0001"");
    }
}
");

        TranslationDiagnostic error = Assert.Single(
            diagnostics,
            d => d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId);
        Assert.Equal(TranslationSeverity.Unsupported, error.Severity);
        Assert.StartsWith("in an analyzer test snippet: '#if DEBUG'", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(
            diagnostics,
            d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
                && d.Message.Contains("#if", StringComparison.Ordinal));
    }

    [Fact]
    public void GenericStoreSnippet_DistinctSourceSitesSurvivePackageDeduplication()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(GenericStoreSnippet);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Equal(4, System.Text.RegularExpressions.Regex.Matches(result.GsWithMarkers, @"Maybe\(\)!!").Count);
        TranslationDiagnostic[] sites = result.Diagnostics
            .Where(d => d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId)
            .ToArray();
        Assert.Equal(4, sites.Length);
        Assert.All(sites, site => Assert.Equal(sites[0].Message, site.Message));
        Assert.Equal(
            SyntaxFactory.ParseCompilationUnit(GenericStoreSnippet).DescendantNodes()
                .OfType<InvocationExpressionSyntax>()
                .Where(node => node.Expression.ToString() == "Maybe")
                .Select(node => node.Span),
            sites.Select(site => site.Location.SourceSpan));
    }

    [Fact]
    public async Task GenericStoreSnippetPipeline_ForwardsEveryInnerSiteAndOneStderrCount()
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", "generic-store-snippets", Guid.NewGuid().ToString("N"));
        string projectDir = Path.Combine(root, "project");
        string outRoot = Path.Combine(root, "migration");
        try
        {
            Directory.CreateDirectory(projectDir);
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project />");
            string projectPath = Path.Combine(projectDir, "Snippets.csproj");
            File.WriteAllText(projectPath, $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
                  <ItemGroup>
                    <Reference Include="Microsoft.CodeAnalysis">
                      <HintPath>{System.Security.SecurityElement.Escape(typeof(Compilation).Assembly.Location)}</HintPath>
                    </Reference>
                    <Reference Include="Microsoft.CodeAnalysis.CSharp">
                      <HintPath>{System.Security.SecurityElement.Escape(typeof(CSharpCompilation).Assembly.Location)}</HintPath>
                    </Reference>
                  </ItemGroup>
                </Project>
                """);
            File.WriteAllText(Path.Combine(projectDir, "Harness.cs"), HarnessSource);
            File.WriteAllText(Path.Combine(projectDir, "Analyzer.cs"), AnalyzerSource);
            File.WriteAllText(Path.Combine(projectDir, "Tests.cs"), $$"""
                namespace Sample.Tests.Cases;
                public sealed class Tests
                {
                    public System.Threading.Tasks.Task Reports()
                    {
                        const string Source = {{Microsoft.CodeAnalysis.CSharp.SymbolDisplay.FormatLiteral(GenericStoreSnippet, quote: true)}};
                        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, "TEST0001");
                    }
                }
                """);
            var pipeline = new MigrationPipeline(
                new PipelineOptions { OutputRoot = outRoot },
                new IMigrationStage[] { new TranslateStage() });
            TextWriter originalError = Console.Error;
            using var capturedError = new StringWriter();
            RunResult result;
            Console.SetError(capturedError);
            try
            {
                result = await pipeline.RunAsync(new[] { new CorpusApp("test/GenericStoreSnippets", projectPath, TargetKind.Library) });
            }
            finally
            {
                Console.SetError(originalError);
            }

            AppResult app = Assert.Single(result.Apps);
            Assert.True(app.Succeeded, app.FailureCategory);
            string printed = File.ReadAllText(Assert.Single(Directory.GetFiles(outRoot, "Tests.gs", SearchOption.AllDirectories)));
            Assert.Equal(4, System.Text.RegularExpressions.Regex.Matches(printed, @"Maybe\(\)!!").Count);
            string log = File.ReadAllText(Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)));
            string[] sites = log.Split('\n')
                .Where(line => line.StartsWith(CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId + " (non-fatal): ", StringComparison.Ordinal))
                .ToArray();
            Assert.True(sites.Length == 4, log);
            Assert.Equal(4, sites.Distinct(StringComparer.Ordinal).Count());
            Assert.All(sites, site => Assert.Contains("Snippet.cs(", site, StringComparison.Ordinal));
            string summary = Assert.Single(
                capturedError.ToString().Split('\n'),
                line => line.Contains(CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId, StringComparison.Ordinal));
            Assert.Contains(": 4 " + CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId + " site(s):", summary, StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    /// <summary>
    /// Translates a two-file analyzer TEST project (harness + cases) in
    /// analyzer mode with the snippet translator wired in, exactly as
    /// <c>TranslateStage</c> does, and returns the printed cases file.
    /// </summary>
    /// <param name="testsSource">The C# test-case source.</param>
    /// <returns>The printed G#.</returns>
    private static string TranslateTests(string testsSource) =>
        TranslateTestsCore(testsSource).Printed;

    private static IReadOnlyList<TranslationDiagnostic> TranslateTestsDiagnostics(string testsSource) =>
        TranslateTestsCore(testsSource).Diagnostics;

    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateTestsCore(string testsSource)
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
        return (GSharpPrinter.Print(unit), context.Diagnostics);
    }
}
