// <copyright file="Issue2519SourceClassConstraintOrderingPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default SDK-backed Oahu.Decrypt constraint-shape coverage for issue #2519.
class Issue2519SourceClassConstraintOrderingPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_SourceClassConstraintsCompileBeforeTheirDeclarations() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDir = Path.Combine(sourceRoot, "src", "OahuDecryptConstraintShape")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "OahuDecryptConstraintShape.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        WriteSources(projectDir)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/OahuDecryptConstraintShape2519", projectPath, TargetKind.Library)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let project = File.ReadAllText(
            Assert.Single(Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.AllDirectories))
        )
        Assert.Contains("AHolder.gs", project, StringComparison.Ordinal)
        Assert.Contains("AMultipartFilterBase.gs", project, StringComparison.Ordinal)
        Assert.Contains("ZEntry.gs", project, StringComparison.Ordinal)
        Assert.True(
            project.IndexOf("AHolder.gs", StringComparison.Ordinal) < project.IndexOf(
                "ZEntry.gs",
                StringComparison.Ordinal
            )
        )
        Assert.True(
            project.IndexOf("AMultipartFilterBase.gs", StringComparison.Ordinal) < project.IndexOf(
                "ZEntry.gs",
                StringComparison.Ordinal
            )
        )
        Assert.True(
            appResult.Succeeded,
            "Expected path-ordered default --via-sdk compilation to resolve source class constraints. Stages: " +
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
    }

    shared {
        private func WriteSources(projectDir string) {
            File.WriteAllText(Path.Combine(projectDir, "AHolder.cs"), `using P;

namespace P.Audio;

public class Holder<T> where T : Entry
{
    public int Read(T value) => value.Count;
}`)
            File.WriteAllText(Path.Combine(projectDir, "AMultipartFilterBase.cs"), `using System.Threading.Tasks;

namespace Oahu.Decrypt.FrameFilters.Audio;

public abstract class MultipartFilterBase<TInput, TCallback> : FrameFinalBase<TInput>
    where TInput : FrameEntry
    where TCallback : Oahu.Decrypt.INewSplitCallback<TCallback>
{
    protected override Task PerformFilteringAsync(TInput input)
    {
        if (input.Chunk is null)
        {
            input.Chunk = new object();
        }

        input.SamplesInFrame += 1;
        return Task.CompletedTask;
    }
}`)
            File.WriteAllText(Path.Combine(projectDir, "YFrameFinalBase.cs"), `using System.Threading.Tasks;

namespace Oahu.Decrypt.FrameFilters.Audio;

public abstract class FrameFinalBase<T>
{
    protected virtual Task PerformFilteringAsync(T input) => Task.CompletedTask;
}`)
            File.WriteAllText(Path.Combine(projectDir, "ZEntry.cs"), `namespace P
{
    public class Entry
    {
        public int Count { get; set; }
    }
}

namespace Oahu.Decrypt
{
    public interface INewSplitCallback<T> where T : INewSplitCallback<T>
    {
    }
}

namespace Oahu.Decrypt.FrameFilters.Audio
{
    public class FrameEntry
    {
        public object? Chunk { get; set; }
        public int SamplesInFrame { get; set; }
    }
}`)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2519", Guid.NewGuid().ToString("N"))
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
