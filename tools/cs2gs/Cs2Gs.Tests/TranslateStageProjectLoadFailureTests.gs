// <copyright file="TranslateStageProjectLoadFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Stage-level regression tests for issue #1742 (review follow-up B1):
/// `LoadedCSharpProject.BoundWithoutErrors` load failures were previously
/// computed by `CSharpProjectLoader` but never checked by any pipeline
/// stage, so a project that failed to bind in C#
/// (missing SDK/targets, an unresolvable `ProjectReference`, ...) still
/// fell through to translation and produced only confusing downstream binding
/// noise. (cref:TranslateStage) must now stop before translating any
/// document and surface the load failure as the stage's own artifact.
open class TranslateStageProjectLoadFailureTests {
    /// A project whose `ProjectReference` points at a file that does not
    /// exist is a classic MSBuild "soft fail" (see also
    /// `CSharpProjectLoaderDiagnosticsTests.LoadProjectAsync_SurfacesMSBuildWorkspaceLoadFailure`).
    /// Running (cref:TranslateStage) alone over it must FAIL the stage
    /// with the `CS2GS0001` load-error diagnostic surfaced in a triage
    /// artifact, instead of proceeding to translate `Program.cs`.
    @Fact
    async func TranslateStage_ProjectFailsToLoad_FailsBeforeTranslating() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-load-failure")
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
        let projectPath = Path.Combine(projectDir, "Broken.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\DoesNotExist\DoesNotExist.csproj" />
  </ItemGroup>
</Project>
`)
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }"
        )
        let outRoot = NewOutputRoot("translate-load-failure")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let app = CorpusApp("test/BrokenLoad", projectPath, TargetKind.Exe)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.False(appResult.Succeeded, "A project that fails to load must not report stage success.")
        Assert.Single(appResult.Stages)
        Assert.Equal("failed", appResult.Stages[0].Status)
        Assert.NotEmpty(appResult.Artifacts)
        let triageFiles = Directory
            .GetFiles(outRoot, "*.json", SearchOption.AllDirectories)
            .Where((f string) -> !Path.GetFileName(f).Equals("summary.json", StringComparison.OrdinalIgnoreCase))
            .ToArray()
        let match string? = triageFiles.FirstOrDefault((f string) -> File.ReadAllText(f).Contains("CS2GS0001"))
        Assert.NotNull(match)
        // No .gs file must have been emitted: the stage must stop before the
        // translate loop runs at all.
        let gsFiles = Directory.GetFiles(outRoot, "*.gs", SearchOption.AllDirectories)
        Assert.Empty(gsFiles)
    }

    shared {
        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func NewScratchDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
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
