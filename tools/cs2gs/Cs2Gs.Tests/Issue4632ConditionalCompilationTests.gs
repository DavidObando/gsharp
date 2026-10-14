// <copyright file="Issue4632ConditionalCompilationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Coverage
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #4632: G# has no conditional compilation, so cs2gs reports every
/// C# `#if` and `#elif` instead of translating the active arm and
/// silently dropping the others.
/// @remarks Discrimination witness (ADR-0154): without the report in
/// `CSharpToGSharpTranslator.TranslateDocument`, the translator records no
/// diagnostic for these sources, so every test here fails (the default-policy
/// pipeline app then succeeds).
open class Issue4632ConditionalCompilationTests {
    @Fact
    func DefaultPolicy_ReportsEveryIfAndElif_AsUnsupportedByDesign() {
        let diagnostics = Translate(Source, CSharpToGSharpTranslator())
        let reported = diagnostics.Where(
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId
        )
            .ToList()
        Assert.Equal(
            []string{
                "IfDirectiveTrivia@7:1 '#if DEBUG'",
                "IfDirectiveTrivia@8:5 '#if INNER'",
                "ElifDirectiveTrivia@12:1 '#elif TRACE && !NOPE'",
                "IfDirectiveTrivia@15:3 '#if NESTED'"
            },
            reported.Select(Describe)
        )
        Assert.All(
            reported,
            (d TranslationDiagnostic) -> {
                Assert.Equal(TranslationSeverity.Unsupported, d.Severity)
                Assert.Equal(UnsupportedClassification.ByDesign, d.Classification)
                Assert.Equal(UnsupportedRationale.Preprocessor, d.Rationale)
                Assert.Contains("G# has no conditional compilation", d.Message, StringComparison.Ordinal)
                Assert.Contains("runtime check", d.Message, StringComparison.Ordinal)
            }
        )
    }

    @Fact
    func WarnPolicy_ReportsEveryIfAndElif_AsWarnings() {
        let translator = CSharpToGSharpTranslator(
            bool(true),
            bool(false),
            default(IReadOnlyCollection[string]),
            default(string),
            bool(true),
            bool(false),
            bool(false),
            bool(false),
            default(string),
            bool(false),
            default(IReadOnlyCollection[string]),
            bool(false),
            bool(false)
        ){ConditionalCompilation = ConditionalCompilationPolicy.Warn}
        let diagnostics = Translate(Source, translator)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
        let reported = diagnostics.Where(
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId
        )
            .ToList()
        Assert.Equal(4, reported.Count)
        Assert.All(
            reported,
            (d TranslationDiagnostic) -> {
                Assert.Equal(TranslationSeverity.Warning, d.Severity)
                Assert.Equal(UnsupportedClassification.ByDesign, d.Classification)
                Assert.Equal(UnsupportedRationale.Preprocessor, d.Rationale)
            }
        )
        Assert.Equal("IfDirectiveTrivia@7:1 '#if DEBUG'", Describe(reported[0]))
    }

    @Fact
    func SourceWithoutConditionalDirectives_ReportsNothing() {
        const plain = "namespace Demo;\n" +
            "#region Kept out\n" +
            "#pragma warning disable CS0168\n" +
            "public static class Probe\n" +
            "{\n" +
            "    public static int Value() => 3;\n" +
            "}\n" +
            "#pragma warning restore CS0168\n" +
            "#endregion\n"
        let diagnostics = Translate(plain, CSharpToGSharpTranslator())
        Assert.DoesNotContain(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId
        )
    }

    @Fact
    func DocumentSplitIntoPackageUnits_ReportsEachDirectiveOnce() {
        const twoNamespaces = "namespace First\n" +
            "{\n" +
            "    public static class A\n" +
            "    {\n" +
            "#if DEBUG\n" +
            "        public static int X => 1;\n" +
            "#endif\n" +
            "    }\n" +
            "}\n" +
            "\n" +
            "namespace Second\n" +
            "{\n" +
            "    public static class B\n" +
            "    {\n" +
            "#if TRACE\n" +
            "        public static int Y => 2;\n" +
            "#endif\n" +
            "    }\n" +
            "}\n"
        let project = CSharpProjectLoader.LoadInMemory([](string, twoNamespaces string){("Split.cs", twoNamespaces)})
        let document = Assert.Single(project.Documents)
        let packages = CSharpToGSharpTranslator.GetDeclaredPackages(document)
        Assert.Equal(2, packages.Count)
        let reported = List[TranslationDiagnostic]()
        for var unitIndex = 0; unitIndex < packages.Count; unitIndex++ {
            let translator = CSharpToGSharpTranslator(
                packageFilter: packages[unitIndex],
                includeFileAttributes: unitIndex == 0,
                includeGlobalNamespace: unitIndex == 0
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            translator.TranslateDocument(document, context)
            reported.AddRange(
                context.Diagnostics.Where(
                    (
                        d TranslationDiagnostic
                    ) -> d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId
                )
            )
        }
        Assert.Equal(
            []string{"IfDirectiveTrivia@5:1 '#if DEBUG'", "IfDirectiveTrivia@15:1 '#if TRACE'"},
            reported.Select(Describe)
        )
    }

    @Fact
    async func TranslateStage_DefaultPolicy_FailsTheAppWithTheDiagnosticId() {
        let (appResult, outRoot) = await RunTranslateStageAsync(
            "translate-conditional-compilation-reject",
            ConditionalCompilationPolicy.Reject
        )
        Assert.False(appResult.Succeeded, "An #if must fail translation by default.")
        let triage = string.Join(
            "\n",
            Directory.GetFiles(outRoot, "*.json", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains(CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId, triage, StringComparison.Ordinal)
        Assert.Contains("#if DEBUG", triage, StringComparison.Ordinal)
    }

    @Fact
    async func TranslateStage_WarnPolicy_ForwardsTheWarningAndTheAppPasses() {
        let (appResult, outRoot) = await RunTranslateStageAsync(
            "translate-conditional-compilation-warn",
            ConditionalCompilationPolicy.Warn
        )
        Assert.True(appResult.Succeeded, appResult.FailureCategory)
        let translateLog = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories))
        )
        Assert.Contains(
            CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId + " (non-fatal)",
            translateLog,
            StringComparison.Ordinal
        )
        Assert.Contains("Native.cs(6,1)", translateLog, StringComparison.Ordinal)
        Assert.Contains("#if DEBUG", translateLog, StringComparison.Ordinal)
    }

    shared {
        // Line numbers below are 1-based; no preprocessor symbol is defined, so
        // the outer #else arm is the active one.
        private const Source string = "namespace Demo;\n" +
            "\n" +
            "public static class Probe\n" +
            "{\n" +
            "    public static int Value()\n" +
            "    {\n" +
            "#if DEBUG\n" +
            "    #if INNER\n" +
            "        return 5;\n" +
            "    #endif\n" +
            "        return 1;\n" +
            "#elif TRACE && !NOPE\n" +
            "        return 2;\n" +
            "#else\n" +
            "  #if NESTED\n" +
            "        return 4;\n" +
            "  #endif\n" +
            "        return 3;\n" +
            "#endif\n" +
            "    }\n" +
            "}\n"

        private func Translate(source string, translator CSharpToGSharpTranslator) IReadOnlyList[
            TranslationDiagnostic
        ] {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            translator.TranslateDocument(document, context)
            return context.Diagnostics
        }

        private func Describe(diagnostic TranslationDiagnostic) string {
            let span = diagnostic.Location!!.GetLineSpan()
            let quoteStart = diagnostic.Message!!.IndexOf('\'', StringComparison.Ordinal)
            let quoteEnd = diagnostic.Message!!.IndexOf('\'', quoteStart + 1)
            let quoted = diagnostic.Message!!.Substring(quoteStart, quoteEnd - quoteStart + 1)
            return "${diagnostic.ConstructKind}@${span.StartLinePosition.Line + 1}:" +
                "${span.StartLinePosition.Character + 1} $quoted"
        }

        private async func RunTranslateStageAsync(label string, policy ConditionalCompilationPolicy)(
            App AppResult,
            OutRoot string
        ) {
            let projectDir = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(projectDir)
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
            let projectPath = Path.Combine(projectDir, "Conditional.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(projectDir, "Native.cs"), `namespace Demo;

public static class Probe
{
    public static int Value()
` + `#if DEBUG
        => 1;
#else
        => 2;
#endif
}
`)
            let outRoot = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outRoot)
            let options = PipelineOptions{OutputRoot: outRoot, ConditionalCompilation: policy}
            let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
            let app = CorpusApp("test/ConditionalCompilation", projectPath, TargetKind.Library)
            let result = await pipeline.RunAsync([]CorpusApp{app})
            return (Assert.Single(result.Apps), outRoot)
        }
    }
}
