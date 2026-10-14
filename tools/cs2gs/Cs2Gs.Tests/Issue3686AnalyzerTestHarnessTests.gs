// <copyright file="Issue3686AnalyzerTestHarnessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Xunit
import Cs2Gs.Pipeline
import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text

/// ADR-0169 M5 / issue #3686: an analyzer project and its TEST project must
/// translate against the SAME analyzer API. Before this, only the project
/// DECLARING an analyzer entered analyzer mode, so the migrated analyzer became
/// a `GSharpDiagnosticAnalyzer` while its migrated tests kept Roslyn's
/// `DiagnosticAnalyzer` contract, and every call site failed GS0154.
/// Covered here: the test-project detection, the harness-body rewrite onto
/// `GSharpAnalyzerVerifier` (which the C# pipeline it replaces has no
/// mapping for at all — the G# verifier takes no metadata references), and the
/// project-file half that supplies the two assemblies the migrated tests bind.
open class Issue3686AnalyzerTestHarnessTests {
    @Fact
    func AnalyzerProject_IsNotItsOwnTestProject() {
        let analyzer = Load(("Analyzer.cs", AnalyzerSource))
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(analyzer.Compilation))
        Assert.False(AnalyzerProjectDetector.IsAnalyzerTestProject(analyzer.Compilation))
    }

    /// The detection this issue is about: the tests declare no analyzer, so the
    /// old "declares one" rule said false and the project translated in
    /// ordinary mode.
    @Fact
    func TestProject_InstantiatingAReferencedAnalyzer_IsDetected() {
        let tests = Load(
            [](string, string){("Harness.cs", HarnessSource), ("Tests.cs", TestsUsing("new Sample.SampleAnalyzer()"))},
            CSharpProjectLoader.RuntimeReferences().Append(CompileAnalyzerToReference()).ToList()
        )
        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(tests.Compilation))
        Assert.True(AnalyzerProjectDetector.IsAnalyzerTestProject(tests.Compilation))
    }

    /// Anti-vacuity guard, and the real hazard of widening the detector:
    /// analyzer mode rewrites EVERY Microsoft.CodeAnalysis use in a project,
    /// so a project that merely consumes Roslyn (cs2gs itself does) must stay
    /// out of it. Instantiating an analyzer from another assembly AND
    /// declaring a harness for it is what counts (#3789).
    @Fact
    func ProjectThatOnlyUsesRoslyn_IsNotAnAnalyzerTestProject() {
        let plain = Load(("Plain.cs", `
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Sample.Plain;

public static class Tool
{
    public static int Count(string source)
        => CSharpSyntaxTree.ParseText(source).GetRoot().DescendantNodes().Count();
}
`))
        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(plain.Compilation))
        Assert.False(AnalyzerProjectDetector.IsAnalyzerTestProject(plain.Compilation))
    }

    /// The third guard, issue #3789: `tools/cs2gs/Cs2Gs.Tests`' shape. It
    /// runs the repo's real GSA analyzers as a LIBRARY — constructing one from
    /// the project-referenced InternalAnalyzers to diff its diagnostics against
    /// the translated analyzer's — while the rest of its ~256
    /// Microsoft.CodeAnalysis uses are cs2gs's own machinery. Instantiation
    /// alone therefore cannot be the signal; claiming this project turned its
    /// 14-error compile wall into 98 translate gaps, the first being
    /// "Microsoft.CodeAnalysis.MetadataReference has no G# analyzer-API
    /// mapping". No harness, no claim.
    @Fact
    func ProjectDrivingAnalyzersAsALibrary_IsNotAnAnalyzerTestProject() {
        let tooling = LoadToolingProject()
        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(tooling.Compilation))
        Assert.False(AnalyzerProjectDetector.IsAnalyzerTestProject(tooling.Compilation))
    }

    /// The mechanism behind #3789, executed rather than asserted: analyzer mode
    /// over that project's Roslyn surface really does gap — it maps every
    /// Microsoft.CodeAnalysis use, and `MetadataReference` has no
    /// analyzer-API counterpart and should not have one. Translating it in the
    /// mode the DETECTOR picks produces no such gap. The forced-mode half is
    /// the anti-vacuity guard: it fails if the gap ever stops being produced,
    /// so the clean half cannot pass for the wrong reason.
    @Fact
    func AnalyzerModeOverALibraryConsumerGaps_TheDetectorsModeDoesNot() {
        let tooling = LoadToolingProject()
        let forced = TranslateFile(tooling, "Tooling.cs", analyzerApiMode: true)
        Assert.Contains(
            forced,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "MetadataReference",
                StringComparison.Ordinal
            ) &&
                d.Message!!.Contains("no G# analyzer-API mapping", StringComparison.Ordinal)
        )
        let chosen = TranslateFile(
            tooling,
            "Tooling.cs",
            AnalyzerProjectDetector.IsAnalyzerTestProject(tooling.Compilation)
        )
        Assert.DoesNotContain(
            chosen,
            (d TranslationDiagnostic) -> d.Message!!.Contains("no G# analyzer-API mapping", StringComparison.Ordinal)
        )
    }

    /// The discriminator itself: the SAME library-consumer file, with an
    /// analyzer test harness added beside it, IS claimed. So the rule keys on
    /// the harness — the one member analyzer mode rewrites for a test project —
    /// and not on the absence of unrelated Roslyn code, which would be a
    /// proportion heuristic with no defensible cut point.
    @Fact
    func AddingAHarnessToTheSameProject_FlipsTheMode() {
        let withHarness = Load(
            [](string, string){
                ("Tooling.cs", ToolingSource),
                ("Harness.cs", HarnessSource),
                ("Tests.cs", TestsUsing("new Sample.SampleAnalyzer()"))
            },
            CSharpProjectLoader.RuntimeReferences().Append(CompileAnalyzerToReference()).ToList()
        )
        Assert.True(AnalyzerProjectDetector.IsAnalyzerTestProject(withHarness.Compilation))
    }

    /// The harness rewrite: the signature (and therefore every call site) is
    /// preserved, the body delegates to the G# verifier, and the Roslyn
    /// compilation plumbing — which has no G# counterpart, since the G#
    /// verifier compiles G# source with no reference set — is gone rather than
    /// half-mapped. The printed G# is then bound against the real GSharp.Core
    /// and the real verifier assembly, so a signature that did not exist would
    /// fail here.
    @Fact
    func HarnessBody_DelegatesToTheGsharpVerifier_AndBindsAgainstGsCore() {
        let (printed, diagnostics) = TranslateHarness(HarnessSource)
        Assert.Contains("analyzer GSharpDiagnosticAnalyzer", printed, StringComparison.Ordinal)
        Assert.Contains(
            "GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, source, diagnosticIds)",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("import GSharp.CodeAnalysis.Analyzers.Testing", printed, StringComparison.Ordinal)
        // The Roslyn pipeline and its private plumbing are gone, not mapped.
        Assert.DoesNotContain("CSharpCompilation", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetAnalyzerDiagnosticsAsync", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("MetadataReference", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetReferences", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("StripMarkers", printed, StringComparison.Ordinal)
        // The substitution is a declared shape adaptation, never silent.
        Assert.Contains(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message!!.Contains(
                "VerifyAnalyzer",
                StringComparison.Ordinal
            )
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    /// The dead-code sweep is scoped: a private helper the harness shares with
    /// another member is still live after the rewrite and must survive.
    @Fact
    func HarnessSupportMemberUsedElsewhere_IsKept() {
        let shared = HarnessSource.Replace("    private static MetadataReference[] GetReferences()", `    public static string Normalize(string source) => StripMarkers(source, new List<(int Line, int Column)>());

    private static MetadataReference[] GetReferences()`, StringComparison.Ordinal)
        let (printed, _) = TranslateHarness(shared)
        Assert.Contains("StripMarkers", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetReferences", printed, StringComparison.Ordinal)
    }

    /// The project half: the migrated tests bind GSharp.Core (the analyzer API)
    /// and the verifier assembly, and — unlike an analyzer, which gsc loads
    /// beside its own copy — a test assembly must COPY both into its output.
    @Fact
    func AnalyzerTestProject_GetsCoreAndVerifierReferences_Copied() {
        let transformed = TransformPair(testProjectXml: `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\Analyzer\Analyzer.csproj" />
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" />
  </ItemGroup>
</Project>`, isAnalyzerTestProject: true)
        // GSharp.Core is still resolved by directory adjacency to gsc and
        // copied into the test project's own output (#3686).
        let references = transformed.Descendants().Where((e XElement) -> e.Name.LocalName == "Reference").ToList()
        Assert.Contains(references, (r XElement) -> r.Attribute(XName?("Include")!!)?.Value == "GSharp.Core")
        Assert.All(
            references,
            (r XElement) -> Assert.Equal(
                "true",
                r.Elements().Single((e XElement) -> e.Name.LocalName == "Private").Value
            )
        )
        // Issue #3780: the verifier is a real NuGet PackageReference now,
        // not a directory-adjacency HintPath Reference.
        let packageReferences = transformed
            .Descendants()
            .Where((e XElement) -> e.Name.LocalName == "PackageReference")
            .ToList()
        let verifierPackageReference = Assert.Single(
            packageReferences,
            (p XElement) -> p.Attribute(XName?("Include")!!)?.Value == "GSharp.CodeAnalysis.Analyzers.Testing"
        )
        Assert.Equal("1.0.0", verifierPackageReference.Attribute(XName?("Version")!!)?.Value)
        // The Roslyn package the harness no longer needs is dropped.
        Assert.DoesNotContain(
            packageReferences,
            (p XElement) -> p
                .Attribute(XName?("Include")!!)
                ?.Value
                ?.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal) == true
        )
    }

    /// An analyzer's CONSUMER (the shape of src/Core: OutputItemType="Analyzer",
    /// ReferenceOutputAssembly="false") references an analyzer project to RUN
    /// it. It is ordinary C# and must keep its own Roslyn packages — mistaking
    /// it for a test project would strip them.
    @Fact
    func AnalyzerConsumerProject_IsNotTreatedAsATestProject() {
        let transformed = TransformPair(testProjectXml: `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\Analyzer\Analyzer.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" />
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" />
  </ItemGroup>
</Project>`)
        Assert.DoesNotContain(
            transformed.Descendants().Where((e XElement) -> e.Name.LocalName == "Reference"),
            (r XElement) -> r
                .Attribute(XName?("Include")!!)
                ?.Value
                ?.StartsWith("GSharp.", StringComparison.Ordinal) == true
        )
        Assert.Contains(
            transformed.Descendants().Where((e XElement) -> e.Name.LocalName == "PackageReference"),
            (p XElement) -> p.Attribute(XName?("Include")!!)?.Value == "Microsoft.CodeAnalysis.CSharp"
        )
    }

    /// Issue #3791: project transformation consumes the semantic detector's
    /// verdict. A structural analyzer reference and an unused analyzer-testing
    /// package do not claim a library consumer; adding the declared harness
    /// plus referenced-analyzer instantiation flips both stages together.
    @Fact
    func AnalyzerDetectorAndProjectTransformer_Agree() {
        const projectXml = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\Analyzer\Analyzer.csproj" />
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" />
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp.Analyzer.Testing.XUnit" Version="1.1.2" />
  </ItemGroup>
</Project>`
        let tooling = LoadToolingProject()
        let toolingVerdict = AnalyzerProjectDetector.IsAnalyzerTestProject(tooling.Compilation)
        let toolingProject = TransformPair(projectXml, toolingVerdict)
        Assert.False(toolingVerdict)
        Assert.DoesNotContain(
            toolingProject.Descendants().Where((e XElement) -> e.Name.LocalName == "Reference"),
            (r XElement) -> r
                .Attribute(XName?("Include")!!)
                ?.Value
                ?.StartsWith("GSharp.", StringComparison.Ordinal) == true
        )
        Assert.Contains(
            toolingProject.Descendants().Where((e XElement) -> e.Name.LocalName == "PackageReference"),
            (p XElement) -> p.Attribute(XName?("Include")!!)
                ?.Value == "Microsoft.CodeAnalysis.CSharp.Analyzer.Testing.XUnit"
        )
        let tests = Load(
            [](string, string){("Harness.cs", HarnessSource), ("Tests.cs", TestsUsing("new Sample.SampleAnalyzer()"))},
            CSharpProjectLoader.RuntimeReferences().Append(CompileAnalyzerToReference()).ToList()
        )
        let testsVerdict = AnalyzerProjectDetector.IsAnalyzerTestProject(tests.Compilation)
        let testProject = TransformPair(projectXml, testsVerdict)
        Assert.True(testsVerdict)
        Assert.Contains(
            testProject.Descendants().Where((e XElement) -> e.Name.LocalName == "PackageReference"),
            (p XElement) -> p.Attribute(XName?("Include")!!)?.Value == "GSharp.CodeAnalysis.Analyzers.Testing"
        )
        Assert.DoesNotContain(
            testProject.Descendants().Where((e XElement) -> e.Name.LocalName == "PackageReference"),
            (p XElement) -> p
                .Attribute(XName?("Include")!!)
                ?.Value
                ?.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal) == true
        )
    }

    shared {
        private const AnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
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
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ElementAccessExpression);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        context.ReportDiagnostic(Diagnostic.Create(Rule, context.Node.GetLocation()));
    }
}
`

        /// Issue #3789: `tools/cs2gs/Cs2Gs.Tests`' shape — Roslyn used as a
        /// LIBRARY, with an analyzer from a referenced assembly constructed
        /// incidentally to diff its output. The `MetadataReference` parameter
        /// is the real project's first analyzer-mode gap.
        private const ToolingSource string = `
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample.Tooling;

public static class ParityCheck
{
    public static int CountDiagnostics(string source, MetadataReference[] references)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var compilation = CSharpCompilation.Create("Corpus", new[] { tree }, references);
        var withAnalyzers = compilation.WithAnalyzers(
            ImmutableArray.Create<DiagnosticAnalyzer>(new Sample.SampleAnalyzer()));
        return withAnalyzers.GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult().Length;
    }
}
`

        /// The repo's own `AnalyzerTestHelper` shape, trimmed to the parts
        /// that matter: the Roslyn compilation pipeline, the metadata-reference
        /// plumbing, and the marker stripping.
        private const HarnessSource string = `
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample.Tests;

internal static class AnalyzerTestHelper
{
    public static async Task AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer, string source, params string[] diagnosticIds)
    {
        var expectedLocations = new List<(int Line, int Column)>();
        var cleanSource = StripMarkers(source, expectedLocations);
        var tree = CSharpSyntaxTree.ParseText(cleanSource, new CSharpParseOptions(LanguageVersion.Preview));
        var compilation = CSharpCompilation.Create(
            "AnalyzerTests",
            new[] { tree },
            GetReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var diagnostics = await compilation.WithAnalyzers(ImmutableArray.Create(analyzer)).GetAnalyzerDiagnosticsAsync();
        if (diagnostics.Length != expectedLocations.Count)
        {
            throw new InvalidOperationException("mismatch");
        }
    }

    private static string StripMarkers(string source, List<(int Line, int Column)> expectedLocations)
    {
        expectedLocations.Add((1, 1));
        return source.Replace("[|", string.Empty).Replace("|]", string.Empty);
    }

    private static MetadataReference[] GetReferences()
    {
        var trusted = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES");
        return trusted.Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p)).ToArray();
    }
}
`

        private func LoadToolingProject() LoadedCSharpProject -> Load(
            [](string, ToolingSource string){("Tooling.cs", ToolingSource)},
            CSharpProjectLoader.RuntimeReferences().Append(CompileAnalyzerToReference()).ToList()
        )

        private func TranslateFile(project LoadedCSharpProject, fileName string, analyzerApiMode bool) IReadOnlyList[
            TranslationDiagnostic
        ] {
            let translator = CSharpToGSharpTranslator(analyzerApiMode: analyzerApiMode)
            let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == fileName)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            translator.TranslateDocument(document, context)
            return context.Diagnostics
        }

        private func TestsUsing(construction string) string -> `
namespace Sample.Tests.Cases;

public sealed class SampleAnalyzerTests
{
    public System.Threading.Tasks.Task Reports()
        => Sample.Tests.AnalyzerTestHelper.AssertDiagnosticsAsync(` + construction + `, "class C { }", "TEST0001");
}
`

        private func Load(source(FileName string, Source string)) LoadedCSharpProject -> Load(
            [](FileName string, Source string){source},
            references: nil
        )

        private func Load(
            sources[](FileName string, Source string),
            references IReadOnlyList[MetadataReference]?
        ) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory(sources, references)
            Assert.True(
                project.BoundWithoutErrors,
                "Fixture should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            return project
        }

        private func CompileAnalyzerToReference() MetadataReference {
            let analyzer = Load(("Analyzer.cs", AnalyzerSource))
            using let stream = MemoryStream()
            let result = analyzer.Compilation.Emit(stream)
            Assert.True(
                result.Success,
                "Analyzer fixture should emit: " + string.Join(Environment.NewLine, result.Diagnostics)
            )
            return MetadataReference.CreateFromImage(stream.ToArray())
        }

        private func TranslateHarness(harnessSource string)(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = Load(("Harness.cs", harnessSource))
            let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
            let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == "Harness.cs")
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = translator.TranslateDocument(document, context)
            return (GSharpPrinter.Print(unit), context.Diagnostics)
        }

        private func AssertBindsAgainstGsCore(printed string) {
            // Issue #3734/#3767: a translated analyzer's references have all been
            // retargeted onto the G# analyzer API, so it must import G# namespaces
            // only — a residual `import Microsoft.CodeAnalysis` would make bare
            // `Diagnostic`/`SyntaxKind` bind by import order.
            Assert.DoesNotContain("import Microsoft.", printed, StringComparison.Ordinal)
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(printed, "harness.gs"))
            Assert.True(
                tree.Diagnostics.IsEmpty,
                "Translated harness should parse cleanly:\n" + string.Join(
                    "\n",
                    tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                ) +
                    `
---
` +
                    printed
            )
            let referencePaths[]string = []string{
                typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location,
                typeof(GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier).Assembly.Location
            }
            using let resolver = ReferenceResolver.WithRuntimeReferences(referencePaths)
            let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree){IsLibrary = true}
            let errors = compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToList()
            Assert.True(
                errors.Count == 0,
                "Translated harness should bind against GSharp.Core and the verifier:\n" + string.Join(
                    "\n",
                    errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                ) +
                    `
---
` +
                    printed
            )
        }

        private func TransformPair(testProjectXml string, isAnalyzerTestProject bool = false) XDocument {
            let root = Path.Combine(Path.GetTempPath(), "cs2gs-3686-" + Guid.NewGuid().ToString("N"))
            try {
                let analyzerDirectory = Path.Combine(root, "Analyzer")
                let testDirectory = Path.Combine(root, "Analyzer.Tests")
                Directory.CreateDirectory(analyzerDirectory)
                Directory.CreateDirectory(testDirectory)
                File.WriteAllText(Path.Combine(analyzerDirectory, "Analyzer.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
</Project>`)
                let testProjectPath = Path.Combine(testDirectory, "Analyzer.Tests.csproj")
                File.WriteAllText(testProjectPath, testProjectXml)
                return GSharpProjectTransformer.Transform(
                    testProjectPath,
                    testDirectory,
                    "Gsharp.NET.Sdk/1.0.0",
                    Dictionary[string, string](StringComparer.OrdinalIgnoreCase),
                    isAnalyzerTestProject,
                    analyzerVerifierPackageVersion: if isAnalyzerTestProject {
                        "1.0.0"
                    } else {
                        default(string?)
                    }
                )
            } finally {
                if Directory.Exists(root) {
                    Directory.Delete(root, recursive: true)
                }
            }
        }
    }
}
