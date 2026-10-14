// <copyright file="Issue2492NullableBoxedConversionPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #2492: the default SDK-backed migration emits nullable value-type
/// construction for an explicit cast from `object?`, and gsc must accept
/// both the stable minimal repro and the Oahu converter shape.
class Issue2492NullableBoxedConversionPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_NullableObjectCast_TranslatesAndCompiles() {
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
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `namespace Sample;

public static class Repro
{
    public static uint? Convert(object? value) => (uint?)value;
}

public sealed class ToStringConverterActivationCode
{
    public uint? Convert(object? value)
    {
        uint? ac = (uint?)value;
        return ac;
    }
}`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/NullableBoxedConversion", projectPath, TargetKind.Library)
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
        Assert.Contains("func Convert(value object?) uint32? -> uint32?(value)", emitted, StringComparison.Ordinal)
        Assert.Contains("class ToStringConverterActivationCode", emitted, StringComparison.Ordinal)
        Assert.Contains("let ac = uint32?(value)", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk compile to accept nullable boxed conversions. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2492", Guid.NewGuid().ToString("N"))
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
