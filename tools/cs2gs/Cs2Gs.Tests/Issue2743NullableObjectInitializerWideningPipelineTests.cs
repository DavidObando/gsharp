// <copyright file="Issue2743NullableObjectInitializerWideningPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2743NullableObjectInitializerWideningPipelineTests
{
    [Fact]
    public async Task Pipeline_NullableObjectInitializerValues_RemainNullAtRuntime()
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
        string projectDirectory = Path.Combine(sourceRoot, "Issue2743");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue2743.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Exe</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), """
            using System;
            using System.Collections.Generic;

            namespace Issue2743;

            public sealed class Config
            {
                public string? Value { get; set; }
            }

            public static class Program
            {
                private static T? Maybe<T>() where T : class => null;

                private static Dictionary<string, object?> BuildDictionary(Config config) =>
                    new Dictionary<string, object?>
                    {
                        ["value"] = config.Value,
                        ["conditional"] = config.Value?.ToString(),
                        ["generic"] = Maybe<string>(),
                    };

                private static List<object?> BuildCollection(Config config) =>
                    new List<object?>
                    {
                        config.Value,
                        config.Value?.ToString(),
                        Maybe<string>(),
                    };

                public static void Main()
                {
                    var config = new Config();
                    var dictionary = BuildDictionary(config);
                    var collection = BuildCollection(config);
                    Console.WriteLine(dictionary.Count);
                    Console.WriteLine(dictionary["value"] == null);
                    Console.WriteLine(dictionary["conditional"] == null);
                    Console.WriteLine(dictionary["generic"] == null);
                    Console.WriteLine(collection.Count);
                    Console.WriteLine(collection[0] == null);
                    Console.WriteLine(collection[1] == null);
                    Console.WriteLine(collection[2] == null);
                }
            }
            """);
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(goldenPath, "3\nTrue\nTrue\nTrue\n3\nTrue\nTrue\nTrue\n");

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/Issue2743",
            projectPath,
            TargetKind.Exe,
            stdoutGolden: goldenPath);
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new TestParityStage() });
        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                    Path.Combine(
                        outputRoot,
                        result.RunId,
                        MigrationPipeline.SanitizeAppId(app.Id)),
                    "*.gs",
                    SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.DoesNotContain("config.Value!!", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("Maybe[string]()!!", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected nullable initializer values to compile and remain null at runtime. Stages: "
                + string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2743",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    projectDirName,
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
