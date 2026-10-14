// <copyright file="Issue3778AnalyzerSnippetDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Security
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// ADR-0169 M5 second half / issue #3778: `SnippetTranslator` existed and
/// was unit-tested, but nothing DISPATCHED it during a migration, so migrated
/// analyzer tests handed C# snippets to a verifier that compiles G#. Covered
/// here: the dispatch rule (what is and is not a snippet), the two real shapes
/// — a snippet arriving through a local, and a snippet composed with `+`
/// out of a shared model — and marker fidelity, which is the part that can
/// make a migrated test pass for the wrong reason.
open class Issue3778AnalyzerSnippetDispatchTests {
    /// Shape 1 of #3778: the snippet is not a literal at the call site, it is
    /// the initializer of a `const string` LOCAL that is passed to the
    /// harness on the next statement. The design #3777 shipped assumed a
    /// literal argument and therefore never fired.
    @Fact
    func SnippetReachingTheHarnessThroughALocal_IsTranslated() {
        let printed = TranslateTests(`
namespace Sample.Tests.Cases;

public sealed class Tests
{
    public System.Threading.Tasks.Task Reports()
    {
        const string Source = "class C { void M(int[] a) { var x = a[0]; } }";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, "TEST0001");
    }
}
`)
        // The G# spelling, not the C# one: a G# `func` with G# parameter order.
        Assert.Contains("func M(a []int32)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("void M(int[] a)", printed, StringComparison.Ordinal)
    }

    /// Shape 2 of #3778: the snippet is COMPOSED — a shared `const string`
    /// model plus a per-test literal. Neither operand is a compilable unit, so
    /// the translatable thing is the concatenation. The migrated test carries
    /// the folded whole and loses the shared-model factoring; that is the
    /// trade, and this test pins it.
    @Fact
    func ComposedSnippet_IsTranslatedAsOneFoldedUnit() {
        let printed = TranslateTests(`
namespace Sample.Tests.Cases;

public sealed class Tests
{
    private const string Model = "class Node { public int[] Values; }\n";

    public System.Threading.Tasks.Task Reports()
    {
        string source = Model + "class C { void M(Node n) { var x = n.Values[0]; } }";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), source, "TEST0001");
    }
}
`)
        // Both halves are present in ONE translated unit, in G# spelling.
        Assert.Contains("class Node", printed, StringComparison.Ordinal)
        Assert.Contains("func M(n Node)", printed, StringComparison.Ordinal)
        // The composition is gone: the initializer is a single literal, so
        // there is no residual `Model + ` concatenation at the use site.
        Assert.DoesNotContain("Model +", printed, StringComparison.Ordinal)
    }

    /// The guard that makes the rule safe. Silently rewriting a string that was
    /// never a snippet is the bad failure mode, so a constant string that does
    /// NOT reach a harness source parameter must survive verbatim — even in the
    /// same class, even when it is valid C# source text.
    @Fact
    func ConstantStringThatNeverReachesTheHarness_IsLeftAlone() {
        let printed = TranslateTests(`
namespace Sample.Tests.Cases;

public sealed class Tests
{
    public string Unrelated()
    {
        const string NotASnippet = "class C { void M(int[] a) { var x = a[0]; } }";
        return NotASnippet;
    }

    public System.Threading.Tasks.Task Reports()
    {
        const string Source = "class D { void M(int[] a) { var x = a[0]; } }";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, "TEST0001");
    }
}
`)
        // Untouched, C# text and all.
        Assert.Contains("class C { void M(int[] a) { var x = a[0]; } }", printed, StringComparison.Ordinal)
        // …while the one that DOES reach the harness was translated. Both
        // halves in one assertion pair: if dispatch stopped firing altogether
        // the first assertion would still hold, so this one is the anti-vacuity
        // guard for it.
        Assert.Contains("class D", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("class D { void M(int[] a)", printed, StringComparison.Ordinal)
    }

    /// Marker fidelity, the crux. The original re-placement rule searched
    /// forward from the previous marker, so a marked name that also occurs
    /// EARLIER in the unit bracketed the wrong declaration — exactly what a
    /// composed snippet produces, because the shared model declares the method
    /// the per-test override re-declares. The rule is now positional: the Nth
    /// occurrence in the C# is the Nth occurrence in the G#.
    @Fact
    func MarkerOnALaterOccurrence_StaysOnThatOccurrence() {
        let result = SnippetTranslator.Translate(`
class Base
{
    public virtual int Rewrite() => 0;
}

class Derived : Base
{
    public override int [|Rewrite|]() => 1;
}
`)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let markerIndex = result.GsWithMarkers!!.IndexOf("[|Rewrite|]", StringComparison.Ordinal)
        let derivedIndex = result.GsWithMarkers!!.IndexOf("class Derived", StringComparison.Ordinal)
        Assert.True(markerIndex > 0, "the marker must be placed: " + result.GsWithMarkers)
        Assert.True(
            markerIndex > derivedIndex,
            "the marker must bracket Derived.Rewrite, not Base.Rewrite: " + result.GsWithMarkers
        )
    }

    /// The other half of marker fidelity: a marked text that does NOT survive
    /// translation is dropped and reported, never silently re-placed somewhere
    /// plausible. The migrated test then fails on a marker/id count mismatch,
    /// which is loud, rather than asserting the wrong span.
    @Fact
    func MarkerWhoseTextDoesNotSurvive_IsDroppedAndReported() {
        let result = SnippetTranslator.Translate(`
class Holder
{
    object Box(int value) => [|(object)value|];
}
`)
        Assert.Single(result.UnplacedMarkers)
        Assert.Contains(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
        )
        Assert.DoesNotContain("[|", result.GsWithMarkers, StringComparison.Ordinal)
    }

    /// A C# snippet spanning several namespaces cannot become one G# unit — G#
    /// declares one package per compilation unit. It used to collapse into the
    /// first namespace, which made a namespace-scoped rule fire, or fail to
    /// fire, on the wrong declarations; issue #3794 splits it into one unit per
    /// package instead, and the verifier compiles the units together.
    @Fact
    func MultiNamespaceSnippet_SplitsIntoOneUnitPerPackage() {
        let result = SnippetTranslator.Translate(`
namespace One
{
    class A { }
}

namespace Two
{
    class B { }
}
`)
        // Issue #3794: the collapse is no longer REPORTED because it no longer
        // HAPPENS. Each declared namespace becomes its own compilation unit,
        // separated by SnippetTranslator.UnitSeparator, and the verifier
        // compiles them together — so a namespace-scoped rule still judges the
        // declarations the C# original meant.
        Assert.NotNull(result.GsWithMarkers)
        Assert.DoesNotContain(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId &&
                d.Message!!.Contains("collapse", StringComparison.Ordinal)
        )
        Assert.Equal(2, result.GsWithMarkers!!.Split("package ", StringSplitOptions.None).Length - 1)
        Assert.Contains("package One", result.GsWithMarkers, StringComparison.Ordinal)
        Assert.Contains("package Two", result.GsWithMarkers, StringComparison.Ordinal)
        Assert.Equal(2, result.GsWithMarkers!!.Split(SnippetTranslator.UnitSeparator, StringSplitOptions.None).Length)
    }

    /// Issue #4632: an `#if` inside an analyzer test snippet fails the
    /// translation like one in ordinary source. The generic snippet re-report
    /// would otherwise turn it into a non-fatal CS2GS-ANALYZER-SNIPPET warning
    /// and keep only the active arm.
    @Fact
    func ConditionalCompilationInASnippet_StaysATranslationError() {
        let diagnostics = TranslateTestsDiagnostics(`
namespace Sample.Tests.Cases;

public sealed class Tests
{
    public System.Threading.Tasks.Task Reports()
    {
        const string Source = "class C {\n#if DEBUG\n void M() { }\n#endif\n}";
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, "TEST0001");
    }
}
`)
        let error = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId
        )
        Assert.Equal(TranslationSeverity.Unsupported, error.Severity)
        Assert.StartsWith("in an analyzer test snippet: '#if DEBUG'", error.Message, StringComparison.Ordinal)
        Assert.DoesNotContain(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId &&
                d.Message!!.Contains("#if", StringComparison.Ordinal)
        )
    }

    @Fact
    func GenericStoreSnippet_DistinctSourceSitesSurvivePackageDeduplication() {
        let result = SnippetTranslator.Translate(GenericStoreSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Equal(4, Regex.Matches(result.GsWithMarkers!!, "Maybe\\(\\)!!").Count)
        let sites = result
            .Diagnostics
            .Where(
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToArray()
        Assert.Equal(4, sites.Length)
        Assert.All(sites, (site TranslationDiagnostic) -> Assert.Equal(sites[0].Message, site.Message))
        Assert.Equal(
            SyntaxFactory
                .ParseCompilationUnit(GenericStoreSnippet)
                .DescendantNodes()
                .OfType[InvocationExpressionSyntax]()
                .Where((node InvocationExpressionSyntax) -> node.Expression.ToString() == "Maybe")
                .Select((node InvocationExpressionSyntax) -> node.Span),
            sites.Select((site TranslationDiagnostic) -> site.Location!!.SourceSpan)
        )
    }

    @Fact
    async func GenericStoreSnippetPipeline_ForwardsEveryInnerSiteAndOneStderrCount() {
        let root = Path.Combine(
            AppContext.BaseDirectory,
            "loader-tests",
            "generic-store-snippets",
            Guid.NewGuid().ToString("N")
        )
        let projectDir = Path.Combine(root, "project")
        let outRoot = Path.Combine(root, "migration")
        try {
            Directory.CreateDirectory(projectDir)
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project />")
            let projectPath = Path.Combine(projectDir, "Snippets.csproj")
            File.WriteAllText(projectPath, (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <Reference Include="Microsoft.CodeAnalysis">
      <HintPath>` + "${SecurityElement.Escape(typeof(Compilation).Assembly.Location)}" + `</HintPath>
    </Reference>
    <Reference Include="Microsoft.CodeAnalysis.CSharp">
      <HintPath>` + "${SecurityElement.Escape(typeof(CSharpCompilation).Assembly.Location)}" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
            File.WriteAllText(Path.Combine(projectDir, "Harness.cs"), HarnessSource)
            File.WriteAllText(Path.Combine(projectDir, "Analyzer.cs"), AnalyzerSource)
            File.WriteAllText(Path.Combine(projectDir, "Tests.cs"), (`namespace Sample.Tests.Cases;
public sealed class Tests
{
    public System.Threading.Tasks.Task Reports()
    {
        const string Source = ` + "${SymbolDisplay.FormatLiteral(GenericStoreSnippet, quote: true)}" + `;
        return Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(new Sample.SampleAnalyzer(), Source, "TEST0001");
    }
}`))
            let pipeline = MigrationPipeline(PipelineOptions{OutputRoot: outRoot}, []IMigrationStage{TranslateStage()})
            let originalError = Console.Error
            using let capturedError = StringWriter()
            var result RunResult
            Console.SetError(capturedError)
            try {
                result = await pipeline.RunAsync(
                    []CorpusApp{CorpusApp("test/GenericStoreSnippets", projectPath, TargetKind.Library)}
                )
            } finally {
                Console.SetError(originalError)
            }
            let app = Assert.Single(result.Apps)
            Assert.True(app.Succeeded, app.FailureCategory)
            let printed = File.ReadAllText(
                Assert.Single(Directory.GetFiles(outRoot, "Tests.gs", SearchOption.AllDirectories))
            )
            Assert.Equal(4, Regex.Matches(printed, "Maybe\\(\\)!!").Count)
            let log = File.ReadAllText(
                Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories))
            )
            let sites = log
                .Split('\n')
                .Where(
                (line string) -> line.StartsWith(
                    CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId + " (non-fatal): ",
                    StringComparison.Ordinal
                )
            )
                .ToArray()
            Assert.True(sites.Length == 4, log)
            Assert.Equal(4, sites.Distinct(StringComparer.Ordinal).Count())
            Assert.All(sites, (site string) -> Assert.Contains("Snippet.cs(", site, StringComparison.Ordinal))
            let summary = Assert.Single(
                capturedError.ToString().Split('\n'),
                (line string) -> line.Contains(
                    CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId,
                    StringComparison.Ordinal
                )
            )
            Assert.Contains(
                ": 4 " + CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId + " site(s):",
                summary,
                StringComparison.Ordinal
            )
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    shared {
        private const GenericStoreSnippet string = `#nullable enable
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
}`

        /// The harness shape the detector keys on (a static method taking an
        /// analyzer and a source string), trimmed to what dispatch needs.
        private const HarnessSource string = `
using System.Threading.Tasks;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample.Tests;

internal static class AnalyzerTestHelper
{
    public static Task AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer, string source, params string[] diagnosticIds)
        => Task.CompletedTask;
}
`

        private const AnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SampleAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0001",
        "Title",
        "Message",
        "Testing",
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
`

        /// Translates a two-file analyzer TEST project (harness + cases) in
        /// analyzer mode with the snippet translator wired in, exactly as
        /// `TranslateStage` does, and returns the printed cases file.
        /// @param testsSource The C# test-case source.
        /// @returns The printed G#.
        private func TranslateTests(testsSource string) string -> TranslateTestsCore(testsSource).Printed

        private func TranslateTestsDiagnostics(testsSource string) IReadOnlyList[
            TranslationDiagnostic
        ] -> TranslateTestsCore(testsSource).Diagnostics

        private func TranslateTestsCore(testsSource string)(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){
                    ("Harness.cs", HarnessSource),
                    ("Analyzer.cs", AnalyzerSource),
                    ("Tests.cs", testsSource)
                }
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Fixture should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
            let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == "Tests.cs")
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath){
                TranslateAnalyzerSnippet = SnippetTranslator.Translate
            }
            let unit = translator.TranslateDocument(document, context)
            return (GSharpPrinter.Print(unit), context.Diagnostics)
        }
    }
}
