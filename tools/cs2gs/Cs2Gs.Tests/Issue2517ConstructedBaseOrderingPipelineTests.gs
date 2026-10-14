// <copyright file="Issue2517ConstructedBaseOrderingPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default SDK-backed Oahu.Decrypt ordering-shape coverage for issue #2517.
class Issue2517ConstructedBaseOrderingPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_EarlyGenericSignatureAndOahuFilterShape_CompileInPathOrder() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDir = Path.Combine(sourceRoot, "src", "OahuDecryptShape")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "OahuDecryptShape.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        WriteSources(projectDir)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/OahuDecryptShape2517", projectPath, TargetKind.Library)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let project = File.ReadAllText(
            Assert.Single(Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.AllDirectories))
        )
        Assert.True(project.IndexOf("0Early.gs", StringComparison.Ordinal) >= 0)
        Assert.True(
            project.IndexOf("0Early.gs", StringComparison.Ordinal) < project.IndexOf(
                "ADerived.gs",
                StringComparison.Ordinal
            )
        )
        Assert.True(
            project.IndexOf("ADerived.gs", StringComparison.Ordinal) < project.IndexOf(
                "YMiddle.gs",
                StringComparison.Ordinal
            )
        )
        Assert.True(
            project.IndexOf("YMiddle.gs", StringComparison.Ordinal) < project.IndexOf(
                "ZBase.gs",
                StringComparison.Ordinal
            )
        )
        Assert.True(
            appResult.Succeeded,
            "Expected path-ordered default --via-sdk compilation to preserve the constructed generic base. Stages: " +
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
    }

    shared {
        private func WriteSources(projectDir string) {
            File.WriteAllText(Path.Combine(projectDir, "0Early.cs"), `using Oahu.Decrypt;

namespace Other;

public sealed class Early
{
    public Middle<Entry, Entry>? Get() => null;
}`)
            File.WriteAllText(Path.Combine(projectDir, "ADerived.cs"), `using Oahu.Decrypt;

namespace Oahu.Decrypt.FrameFilters.Audio;

public sealed class AacValidateFilter : Middle<Entry, Entry>
{
    public AacValidateFilter() : base(1) { }

    protected override int InputBufferSize => 100;

    public int Inspect() =>
        InputBufferSize + SamplesInFrame + (Disposed ? 0 : 1) + (Chunk is null ? 1 : 0);

    public void Report() => OnProgressUpdate();
}`)
            File.WriteAllText(Path.Combine(projectDir, "Entry.cs"), `namespace Oahu.Decrypt;

public sealed class Entry { }`)
            File.WriteAllText(Path.Combine(projectDir, "YMiddle.cs"), `namespace Oahu.Decrypt;

public abstract class Middle<TInput, TOutput> : Base<TInput>
{
    protected Middle(int seed) : base(seed) { }
}`)
            File.WriteAllText(Path.Combine(projectDir, "ZBase.cs"), `namespace Oahu.Decrypt;

public abstract class Base<T>
{
    protected Base(int seed) => SamplesInFrame = seed;

    protected abstract int InputBufferSize { get; }
    protected bool Disposed { get; }
    protected T? Chunk { get; }
    protected int SamplesInFrame { get; }
    protected void OnProgressUpdate() { }
}`)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2517", Guid.NewGuid().ToString("N"))
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
