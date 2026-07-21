// <copyright file="Issue2546MethodGroupPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2546MethodGroupPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdk_LinqSourceMethodGroup_TranslatesAndCompiles()
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
        string projectPath = WriteFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2546", projectPath, TargetKind.Library) });
        AppResult app = Assert.Single(result.Apps);
        string emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId);

        Assert.Contains("records.Select(ToDictionary)", emitted, StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected imported LINQ Select to accept the source method group. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2546");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "Issue2546.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System.Collections.Generic;
            using System.Linq;

            namespace Issue2546;

            public sealed record Record(string Value);

            public static class Repro
            {
                public static Dictionary<string, string> ToDictionary<T>(T record) =>
                    new() { ["value"] = "present" };

                public static int Run(IEnumerable<Record> records) =>
                    records.Select(ToDictionary).Single().Count;
            }
            """);
        return projectPath;
    }

    private static string ReadAppOutput(string outputRoot, string runId, string appId)
    {
        string directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId));
        return string.Join(
            Environment.NewLine,
            Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2546",
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
