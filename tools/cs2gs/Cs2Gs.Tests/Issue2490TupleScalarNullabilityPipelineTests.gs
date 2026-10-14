// <copyright file="Issue2490TupleScalarNullabilityPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2490TupleScalarNullabilityPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_TupleElementForwarding_TranslatesAndCompiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDir = Path.Combine(sourceRoot, "src", "Sample")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "Sample.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `using System.Collections.Generic;

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
}`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/TupleScalar", projectPath, TargetKind.Library)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains(
            "func Gather(ok bool)(Items List[string]?, Stats Statistics?)",
            emitted,
            StringComparison.Ordinal
        )
        Assert.Contains("func Cleanup(items List[string]?, stats Statistics?) int32", emitted, StringComparison.Ordinal)
        Assert.Contains("func CleanupCore(items List[string]?) int32", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected the default --via-sdk compile to accept tuple-element forwarding. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2490", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName)
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
