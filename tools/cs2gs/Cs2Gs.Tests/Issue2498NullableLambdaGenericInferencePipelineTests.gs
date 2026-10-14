// <copyright file="Issue2498NullableLambdaGenericInferencePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default SDK-backed migration coverage for issue #2498.
class Issue2498NullableLambdaGenericInferencePipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_NullableLambdaProjection_TranslatesAndCompiles() {
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
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `using System.Collections.Generic;
using System.Linq;

namespace Sample;

public static class Repro
{
    public static IEnumerator<T>?[] Build<T>(IEnumerable<T>[] source)
    {
        IEnumerator<T>?[] values = source
            .Select(item => item.GetEnumerator())
            .Select(item => item.MoveNext() ? item : null)
            .ToArray();
        values[0] = null;
        return values;
    }

    public static List<string?> BuildList(string[] source)
    {
        List<string?> values = source
            .Select(value => value.Length > 0 ? value : null)
            .ToList();
        values[0] = null;
        return values;
    }
}`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/NullableLambdaInference", projectPath, TargetKind.Library)
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
        Assert.Contains("default(IEnumerator[T]?)", emitted, StringComparison.Ordinal)
        Assert.Contains("values[0] = nil", emitted, StringComparison.Ordinal)
        Assert.Contains("List[string?]", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to preserve nullable lambda projections. Stages: " +
                string.Join("; ", appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status))
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2498", Guid.NewGuid().ToString("N"))
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
