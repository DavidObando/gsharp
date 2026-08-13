// <copyright file="Issue3083WithLambdaRoundTripTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3083WithLambdaRoundTripTests
{
    private const string WithSource = """
        using System;
        using System.Collections.Generic;
        using System.Linq;

        namespace Issue3083;

        public sealed record ScenarioStep(string From, string To);

        public sealed record ArchScenario(IReadOnlyList<ScenarioStep> Steps);

        public sealed record ArchitectureDoc(IReadOnlyList<ArchScenario>? Scenarios);

        public static class Program
        {
            public static List<ArchScenario> Project(
                ArchitectureDoc doc,
                HashSet<string> ids)
            {
                var scenarios = (doc.Scenarios ?? [])
                    .Select(s => s with
                    {
                        Steps = s.Steps
                            .Where(st => ids.Contains(st.From) && ids.Contains(st.To))
                            .ToList(),
                    })
                    .Where(s => s.Steps.Count >= 2)
                    .ToList();
                return scenarios;
            }

            public static void Main()
            {
                var ids = new HashSet<string> { "a", "b", "c" };
                var doc = new ArchitectureDoc(
                    new List<ArchScenario>
                    {
                        new ArchScenario(
                            new List<ScenarioStep>
                            {
                                new ScenarioStep("a", "b"),
                                new ScenarioStep("b", "c"),
                                new ScenarioStep("c", "x"),
                            }),
                    });
                Console.WriteLine(Project(doc, ids).Single().Steps.Count);
            }
        }
        """;

    private const string TypedNullSource = """
        using System;

        namespace Issue3083;

        public static class Repro
        {
            public static int WordCount(string text) =>
                text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
        }
        """;

    [Fact]
    public void SelectWithExpressionFollowedByWhere_RoundTrips()
    {
        string printed = Translate(WithSource);
        Assert.Contains(
            ".Select((s ArchScenario) -> (s with { Steps = ",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("})).Where((s ArchScenario) ->", printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public void TypedNullArrayCast_UsesDefaultAndRoundTrips()
    {
        string printed = Translate(TypedNullSource);

        Assert.Contains(
            "Split(default([]?char), StringSplitOptions.RemoveEmptyEntries)",
            printed,
            StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public async Task SelectWithExpressionFollowedByWhere_CompilesAndRuns()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue3083");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue3083.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), WithSource);
        string stdoutGolden = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(stdoutGolden, "2\n");

        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                Config = "Debug",
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new TestParityStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue3083", projectPath, TargetKind.Exe, stdoutGolden) });
        AppResult app = Assert.Single(result.Apps);

        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                    Path.Combine(
                        outputRoot,
                        result.RunId,
                        MigrationPipeline.SanitizeAppId(app.AppId)),
                    "*.gs",
                    SearchOption.AllDirectories)
                .Select(File.ReadAllText));
        Assert.Contains(
            ".Select((s ArchScenario) -> (s with { Steps = ",
            emitted,
            StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected translated LINQ with-expression to compile and run. Stages: "
                + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }

    private static void AssertRoundTrip(string printed)
    {
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + printed);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue3083",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Debug", "Release" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    projectDirectoryName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
