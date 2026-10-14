// <copyright file="Issue2494EnumLinqExtremaPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #2494: the default SDK-backed migration must compile both the minimal
/// enum-array Min shape and the Select/Distinct/Min pipeline that exposed the
/// same symbolic enum erasure in Oahu.
class Issue2494EnumLinqExtremaPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_SourceEnumMinShapes_TranslateAndCompile() {
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

public enum Choice { Low, High }
public enum EConversionState { None, Partial, Complete }

public sealed class Conversion
{
    public EConversionState ApplicableState() => EConversionState.Complete;
}

public sealed class Component
{
    public required Conversion Conversion { get; init; }
}

public sealed class Book
{
    public required List<Component> Components { get; init; }
}

public static class Repro
{
    public static Choice Pick() =>
        new[] { Choice.Low, Choice.High }.Min();

    public static EConversionState ApplicableState(Book book)
    {
        var state = book.Components
            .Select(c => c.Conversion.ApplicableState())
            .Distinct()
            .Min();
        return state;
    }
}`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/EnumLinqExtrema", projectPath, TargetKind.Library)
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
        Assert.Contains("func Pick() Choice", emitted, StringComparison.Ordinal)
        Assert.Contains("[]Choice{Choice.Low, Choice.High}.Min()", emitted, StringComparison.Ordinal)
        Assert.Contains("func ApplicableState(book Book) EConversionState", emitted, StringComparison.Ordinal)
        Assert.Contains(".Distinct().Min()", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk compile to preserve source enum identity through Min. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2494", Guid.NewGuid().ToString("N"))
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
