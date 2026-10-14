// <copyright file="Issue2743NullableObjectInitializerWideningPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2743NullableObjectInitializerWideningPipelineTests {
    @Fact
    async func Pipeline_NullableObjectInitializerValues_RemainNullAtRuntime() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDirectory = Path.Combine(sourceRoot, "Issue2743")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue2743.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;
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
}`)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, `3
True
True
True
3
True
True
True
`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue2743", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id)),
                "*.gs",
                SearchOption.AllDirectories
            )
                .Select(File.ReadAllText)
        )
        Assert.DoesNotContain("config.Value!!", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("Maybe[string]()!!", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected nullable initializer values to compile and remain null at runtime. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2743", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirName,
                        dllName
                    )
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
