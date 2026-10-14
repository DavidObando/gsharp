// <copyright file="Issue2500NullableExplicitGenericArgumentsPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2500NullableExplicitGenericArgumentsPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_OahuTaskShape_PreservesNullableTypeArgumentsAndCompiles() {
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
        File.WriteAllText(Path.Combine(projectDir, "Mp4Operation.cs"), `using System.Runtime.CompilerServices;
using System.Threading.Tasks;

namespace Sample;

public sealed class Mp4Operation<TOutput>
{
    private readonly Task<TOutput?>? continuation;

    public Mp4Operation(Task<TOutput?>? continuation)
    {
        this.continuation = continuation;
    }

    public Task<TOutput?> OperationTask =>
        continuation ?? Task.FromResult<TOutput?>(default);

    public TaskAwaiter<TOutput?> GetAwaiter() =>
        (continuation ?? Task.FromResult<TOutput?>(default)).GetAwaiter();

    public async Task<TOutput?> CompleteAsync() =>
        await OperationTask;
}`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/NullableExplicitGenericArguments", projectPath, TargetKind.Library)
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
        Assert.Equal(2, CountOccurrences(emitted, "Task.FromResult[TOutput?](default(TOutput?))"))
        Assert.Contains("prop OperationTask Task[TOutput?]", emitted, StringComparison.Ordinal)
        Assert.Contains("async func CompleteAsync() TOutput?", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept the Oahu Task.FromResult<TOutput?> shape. Stages: " +
                string.Join("; ", appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status))
        )
    }

    shared {
        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var index = 0
            while (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += value.Length
            }
            return count
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2500", Guid.NewGuid().ToString("N"))
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
