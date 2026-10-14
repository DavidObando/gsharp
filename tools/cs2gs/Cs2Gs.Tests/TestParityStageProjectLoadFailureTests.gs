// <copyright file="TestParityStageProjectLoadFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Stage-level regression test for issue #1742 (review follow-up B1): the
/// library xUnit-parity path of (cref:TestParityStage) translates the
/// sibling `.Tests` project via `CSharpProjectLoader.LoadProjectAsync`
/// but, before this fix, never checked whether that load even bound in C#. A
/// `.Tests` project that fails to load (missing SDK/targets, an
/// unresolvable `ProjectReference`, ...) must now FAIL the stage with the
/// load error surfaced, instead of being silently treated as "translation
/// pending" (a pass) or crashing further down the translate loop.
open class TestParityStageProjectLoadFailureTests {
    /// Directly exercises (cref:TestParityStage.ExecuteAsync) (no need
    /// for the earlier stages to have run — the library path only requires
    /// `TestsProjectPath`/`TestsBaselinePath` to be eligible) against
    /// a `.Tests` project whose `ProjectReference` is unresolvable.
    @Fact
    async func TestParityStage_TestsProjectFailsToLoad_FailsInsteadOfSkipping() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let testsDir = NewScratchDir("testparity-load-failure")
        File.WriteAllText(Path.Combine(testsDir, "Directory.Build.props"), "<Project></Project>")
        let testsProjectPath = Path.Combine(testsDir, "Broken.Tests.csproj")
        File.WriteAllText(testsProjectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\DoesNotExist\DoesNotExist.csproj" />
  </ItemGroup>
</Project>
`)
        File.WriteAllText(Path.Combine(testsDir, "SomeTests.cs"), "public class SomeTests { public void T() { } }")
        let baselinePath = Path.Combine(testsDir, "baseline.tests.json")
        File.WriteAllText(
            baselinePath,
            "{\"schemaVersion\":\"1.0\",\"app\":\"Broken.Tests\",\"framework\":\"xunit\"," +
                "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}"
        )
        let appRunDir = NewOutputRoot("testparity-load-failure")
        let app = CorpusApp(
            "test/BrokenTestsLoad",
            Path.Combine(testsDir, "Broken.Tests.csproj"),
            TargetKind.Library,
            testsProjectPath: testsProjectPath,
            testsBaselinePath: baselinePath
        )
        let options = PipelineOptions{GscPath: compiler}
        let gsc = GscInvoker(compiler)
        let triage = TriageBuilder("run_1", "2026-06-21T20:00:00Z", gsc.GetVersion(), app.Id)
        let context = StageExecutionContext(app, options, gsc, appRunDir, triage)
        let stage = TestParityStage()
        let outcome = await stage.ExecuteAsync(context)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.NotEmpty(outcome.Artifacts)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "CS2GS0001")
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
