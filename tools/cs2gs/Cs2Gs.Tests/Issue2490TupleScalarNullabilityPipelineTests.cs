// <copyright file="Issue2490TupleScalarNullabilityPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2490TupleScalarNullabilityPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_TupleElementForwarding_TranslatesAndCompiles()
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
        string projectDir = Path.Combine(sourceRoot, "src", "Sample");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Sample.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System.Collections.Generic;

            namespace Sample;

            public sealed class Statistics
            {
            }

            public static class Repro
            {
                public static int Run(bool ok)
                {
                    var result = Gather(ok);
                    return Cleanup(result.Items, result.Stats);
                }

                private static (List<string> Items, Statistics Stats) Gather(bool ok)
                {
                    if (!ok)
                        return default;

                    return (new List<string>(), new Statistics());
                }

                private static int Cleanup(List<string> items, Statistics stats) =>
                    CleanupCore(items);

                private static int CleanupCore(List<string> items)
                {
                    if (items is null)
                        return 0;

                    return items.Count;
                }
            }
            """);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/TupleScalar", projectPath, TargetKind.Library);
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        Assert.True(options.CompileViaSdk);

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains(
            "func Gather(ok bool) (List[string]?, Statistics?)",
            emitted,
            StringComparison.Ordinal);
        Assert.Contains(
            "func Cleanup(items List[string]?, stats Statistics?) int32",
            emitted,
            StringComparison.Ordinal);
        Assert.Contains(
            "func CleanupCore(items List[string]?) int32",
            emitted,
            StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected the default --via-sdk compile to accept tuple-element forwarding. Stages: " +
                string.Join("; ", appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2490",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName,
                    "out",
                    "bin",
                    config,
                    projectDirName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
