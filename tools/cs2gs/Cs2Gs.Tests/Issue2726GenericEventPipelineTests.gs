// <copyright file="Issue2726GenericEventPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #2726: translated generic EventHandler events retain their open delegate identity.
class Issue2726GenericEventPipelineTests {
    @Fact
    async func TranslatedGenericEventHandler_LambdaRunsAndIlVerifies() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDirectory = Path.Combine(sourceRoot, "Issue2726")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue2726.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;

namespace Issue2726;

public sealed class GenericRaiser<T> where T : EventArgs
{
    public event EventHandler<T>? Changed;

    public int Run(T args)
    {
        var hits = 0;
        Changed += (sender, value) => { hits++; };
        Changed?.Invoke(this, args);
        return hits;
    }
}

public static class Program
{
    public static void Main() =>
        Console.WriteLine(new GenericRaiser<EventArgs>().Run(EventArgs.Empty));
}`)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, "1\n")
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue2726", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let translated = File.ReadAllText(
            Directory.GetFiles(appDirectory, "Program.gs", SearchOption.AllDirectories).Single()
        )
        Assert.Contains("event Changed EventHandler[T]", translated, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
    }

    shared {
        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2726", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
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
