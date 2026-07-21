// <copyright file="Issue2579NullableReferenceFidelityPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2579NullableReferenceFidelityPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdk_NullableWarningBoundaries_TranslateAndCompile()
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
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2579", projectPath, TargetKind.Library) });
        AppResult app = Assert.Single(result.Apps);
        string emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId);

        Assert.Contains("item!!.Next!!.Name", emitted, StringComparison.Ordinal);
        Assert.Contains("item!!.Label()", emitted, StringComparison.Ordinal);
        Assert.Contains("items!!.Count()", emitted, StringComparison.Ordinal);
        Assert.Contains("for current in items!!", emitted, StringComparison.Ordinal);
        Assert.Contains("var required = key!!", emitted, StringComparison.Ordinal);
        Assert.Contains("required = key!!", emitted, StringComparison.Ordinal);
        Assert.Contains("Repro.Required = key!!", emitted, StringComparison.Ordinal);
        Assert.Contains("Repro.Consume(key!!)", emitted, StringComparison.Ordinal);
        Assert.Contains("map_[key!!]", emitted, StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected nullable-enabled warning boundaries to compile via gsc. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2579");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "Issue2579.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System.Collections.Generic;
            using System.Linq;

            namespace Issue2579;

            public sealed class Item
            {
                public string Name => "item";
                public Item? Next => null;
            }

            public static class ItemExtensions
            {
                public static string Label(this Item item) => item.Name;
            }

            public static class Repro
            {
                private static string Required = "";
                private static void Consume(string value) { }

                public static int Run(
                    Item? item,
                    IEnumerable<Item>? items,
                    Dictionary<string, string> map,
                    string? key)
                {
                    _ = item.Next.Name;
                    _ = item.Label();
                    _ = items.Count();
                    foreach (var current in items)
                        _ = current.Name;
                    string required = key;
                    required = key;
                    Required = key;
                    Consume(key);
                    _ = map[key];
                    return required.Length;
                }
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
            "issue2579",
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
