// <copyright file="Issue4632ConditionalCompilationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Coverage;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4632: G# has no conditional compilation, so cs2gs reports every
/// C# <c>#if</c> and <c>#elif</c> instead of translating the active arm and
/// silently dropping the others.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): without the report in
/// <c>CSharpToGSharpTranslator.TranslateDocument</c>, the translator records no
/// diagnostic for these sources, so every test here fails (the default-policy
/// pipeline app then succeeds).
/// </remarks>
public class Issue4632ConditionalCompilationTests
{
    // Line numbers below are 1-based; no preprocessor symbol is defined, so
    // the outer #else arm is the active one.
    private const string Source =
        "namespace Demo;\n" + // 1
        "\n" + // 2
        "public static class Probe\n" + // 3
        "{\n" + // 4
        "    public static int Value()\n" + // 5
        "    {\n" + // 6
        "#if DEBUG\n" + // 7
        "    #if INNER\n" + // 8: inside an inactive arm
        "        return 5;\n" + // 9
        "    #endif\n" + // 10
        "        return 1;\n" + // 11
        "#elif TRACE && !NOPE\n" + // 12
        "        return 2;\n" + // 13
        "#else\n" + // 14
        "  #if NESTED\n" + // 15: inside the active arm
        "        return 4;\n" + // 16
        "  #endif\n" + // 17
        "        return 3;\n" + // 18
        "#endif\n" + // 19
        "    }\n" + // 20
        "}\n";

    [Fact]
    public void DefaultPolicy_ReportsEveryIfAndElif_AsUnsupportedByDesign()
    {
        IReadOnlyList<TranslationDiagnostic> diagnostics = Translate(Source, new CSharpToGSharpTranslator());

        List<TranslationDiagnostic> reported = diagnostics
            .Where(d => d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId)
            .ToList();
        Assert.Equal(
            new[]
            {
                "IfDirectiveTrivia@7:1 '#if DEBUG'",
                "IfDirectiveTrivia@8:5 '#if INNER'",
                "ElifDirectiveTrivia@12:1 '#elif TRACE && !NOPE'",
                "IfDirectiveTrivia@15:3 '#if NESTED'",
            },
            reported.Select(Describe));
        Assert.All(reported, d =>
        {
            Assert.Equal(TranslationSeverity.Unsupported, d.Severity);
            Assert.Equal(UnsupportedClassification.ByDesign, d.Classification);
            Assert.Equal(UnsupportedRationale.Preprocessor, d.Rationale);
            Assert.Contains("G# has no conditional compilation", d.Message, StringComparison.Ordinal);
            Assert.Contains("runtime check", d.Message, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void WarnPolicy_ReportsEveryIfAndElif_AsWarnings()
    {
        var translator = new CSharpToGSharpTranslator
        {
            ConditionalCompilation = ConditionalCompilationPolicy.Warn,
        };
        IReadOnlyList<TranslationDiagnostic> diagnostics = Translate(Source, translator);

        Assert.DoesNotContain(diagnostics, d => d.IsUnsupported);
        List<TranslationDiagnostic> reported = diagnostics
            .Where(d => d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId)
            .ToList();
        Assert.Equal(4, reported.Count);
        Assert.All(reported, d => Assert.Equal(TranslationSeverity.Warning, d.Severity));
        Assert.Equal("IfDirectiveTrivia@7:1 '#if DEBUG'", Describe(reported[0]));
    }

    [Fact]
    public void SourceWithoutConditionalDirectives_ReportsNothing()
    {
        const string plain =
            "namespace Demo;\n" +
            "#region Kept out\n" +
            "#pragma warning disable CS0168\n" +
            "public static class Probe\n" +
            "{\n" +
            "    public static int Value() => 3;\n" +
            "}\n" +
            "#pragma warning restore CS0168\n" +
            "#endregion\n";
        IReadOnlyList<TranslationDiagnostic> diagnostics = Translate(plain, new CSharpToGSharpTranslator());

        Assert.DoesNotContain(
            diagnostics,
            d => d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId);
    }

    [Fact]
    public void DocumentSplitIntoPackageUnits_ReportsEachDirectiveOnce()
    {
        const string twoNamespaces =
            "namespace First\n" + // 1
            "{\n" + // 2
            "    public static class A\n" + // 3
            "    {\n" + // 4
            "#if DEBUG\n" + // 5
            "        public static int X => 1;\n" + // 6
            "#endif\n" + // 7
            "    }\n" + // 8
            "}\n" + // 9
            "\n" + // 10
            "namespace Second\n" + // 11
            "{\n" + // 12
            "    public static class B\n" + // 13
            "    {\n" + // 14
            "#if TRACE\n" + // 15
            "        public static int Y => 2;\n" + // 16
            "#endif\n" + // 17
            "    }\n" + // 18
            "}\n";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Split.cs", twoNamespaces) });
        LoadedDocument document = Assert.Single(project.Documents);
        IReadOnlyList<string> packages = CSharpToGSharpTranslator.GetDeclaredPackages(document);
        Assert.Equal(2, packages.Count);

        var reported = new List<TranslationDiagnostic>();
        for (int unitIndex = 0; unitIndex < packages.Count; unitIndex++)
        {
            var translator = new CSharpToGSharpTranslator(
                packageFilter: packages[unitIndex],
                includeFileAttributes: unitIndex == 0,
                includeGlobalNamespace: unitIndex == 0);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            translator.TranslateDocument(document, context);
            reported.AddRange(context.Diagnostics.Where(
                d => d.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId));
        }

        Assert.Equal(
            new[] { "IfDirectiveTrivia@5:1 '#if DEBUG'", "IfDirectiveTrivia@15:1 '#if TRACE'" },
            reported.Select(Describe));
    }

    [Fact]
    public async Task TranslateStage_DefaultPolicy_FailsTheAppWithTheDiagnosticId()
    {
        (AppResult appResult, string outRoot) = await RunTranslateStageAsync(
            "translate-conditional-compilation-reject",
            ConditionalCompilationPolicy.Reject);

        Assert.False(appResult.Succeeded, "An #if must fail translation by default.");
        string triage = string.Join(
            "\n",
            Directory.GetFiles(outRoot, "*.json", SearchOption.AllDirectories).Select(File.ReadAllText));
        Assert.Contains(CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId, triage, StringComparison.Ordinal);
        Assert.Contains("#if DEBUG", triage, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TranslateStage_WarnPolicy_ForwardsTheWarningAndTheAppPasses()
    {
        (AppResult appResult, string outRoot) = await RunTranslateStageAsync(
            "translate-conditional-compilation-warn",
            ConditionalCompilationPolicy.Warn);

        Assert.True(appResult.Succeeded, appResult.FailureCategory);
        string translateLog = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)));
        Assert.Contains(
            CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId + " (non-fatal)",
            translateLog,
            StringComparison.Ordinal);
        Assert.Contains("Native.cs(6,1)", translateLog, StringComparison.Ordinal);
        Assert.Contains("#if DEBUG", translateLog, StringComparison.Ordinal);
    }

    private static IReadOnlyList<TranslationDiagnostic> Translate(string source, CSharpToGSharpTranslator translator)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        translator.TranslateDocument(document, context);
        return context.Diagnostics;
    }

    private static string Describe(TranslationDiagnostic diagnostic)
    {
        FileLinePositionSpan span = diagnostic.Location.GetLineSpan();
        int quoteStart = diagnostic.Message.IndexOf('\'', StringComparison.Ordinal);
        int quoteEnd = diagnostic.Message.IndexOf('\'', quoteStart + 1);
        string quoted = diagnostic.Message.Substring(quoteStart, quoteEnd - quoteStart + 1);
        return $"{diagnostic.ConstructKind}@{span.StartLinePosition.Line + 1}:"
            + $"{span.StartLinePosition.Character + 1} {quoted}";
    }

    private static async Task<(AppResult App, string OutRoot)> RunTranslateStageAsync(
        string label,
        ConditionalCompilationPolicy policy)
    {
        string projectDir = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(projectDir);
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Conditional.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(projectDir, "Native.cs"),
            "namespace Demo;\n\npublic static class Probe\n{\n    public static int Value()\n"
                + "#if DEBUG\n        => 1;\n#else\n        => 2;\n#endif\n}\n");

        string outRoot = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outRoot);
        var options = new PipelineOptions { OutputRoot = outRoot, ConditionalCompilation = policy };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });
        var app = new CorpusApp("test/ConditionalCompilation", projectPath, TargetKind.Library);

        RunResult result = await pipeline.RunAsync(new[] { app });
        return (Assert.Single(result.Apps), outRoot);
    }
}
