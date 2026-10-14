// <copyright file="TestParityStageFalseGreenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #1749 mode 1: the stage-4 (ADR-0115 §C/§E)
/// library xUnit-parity path used to report (cref:StageOutcome.Passed)
/// for both (cref:GsharpTestRunStatus.Unavailable) (no locally-built SDK
/// — genuinely not verified) and (cref:GsharpTestRunStatus.BuildFailed)
/// (the translated G# test project failed to build — a real regression, since
/// the same library green-built standalone `gsc` in stage 2). Both
/// silently reported "passed" in the machine-readable (cref:StageResult).
/// Now `Unavailable` maps to the distinct (cref:StageStatus.Skipped)
/// ("not verified", never green) and `BuildFailed` maps to
/// (cref:StageStatus.Failed) (a genuine regression).
open class TestParityStageFalseGreenTests {
    /// A locally-built-SDK-unavailable run must report `skipped`, never
    /// `passed`: "not verified" must not render as "verified green".
    @Fact
    async func LibraryParity_SdkUnavailable_IsSkipped_NotPassed() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let outcome = await RunLibraryParityWithFakeResult(
            compiler,
            GsharpTestRunResult.Unavailable("no locally-built Gsharp.NET.Sdk nupkg")
        )
        Assert.Equal(StageStatus.Skipped, outcome.Status)
        Assert.NotEqual(StageStatus.Passed, outcome.Status)
        Assert.Empty(outcome.Artifacts)
    }

    /// A translated G# test project that fails to build is a genuine
    /// regression (the library already green-built standalone `gsc` in
    /// stage 2) and must FAIL the stage — never `passed`, and never
    /// silently downgraded to a skip either.
    @Fact
    async func LibraryParity_BuildFailed_FailsStage_NotPassedOrSkipped() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let outcome = await RunLibraryParityWithFakeResult(
            compiler,
            GsharpTestRunResult.BuildFailed(1, "error GS9999: something broke")
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.NotEqual(StageStatus.Passed, outcome.Status)
        Assert.NotEqual(StageStatus.Skipped, outcome.Status)
        Assert.NotEmpty(outcome.Artifacts)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-BUILD-FAILED")
    }

    /// Wired through (cref:MigrationPipeline) (not just the stage in
    /// isolation): a skipped stage-4 must show up as `"skipped"` in the
    /// machine-readable (cref:StageResult), not `"passed"` — the
    /// overall pipeline must never treat "not verified" as green.
    @Fact
    async func Pipeline_SkippedStage_ReportsSkipped_NotPassed() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let (app, outRoot) = NewMinimalLibraryApp("pipeline-skip")
        let fakeRunner = FakeGsharpTestProjectRunner(
            GsharpTestRunResult.Unavailable("no locally-built Gsharp.NET.Sdk nupkg")
        )
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TestParityStage(fakeRunner)})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let stage = Assert.Single(appResult.Stages)
        Assert.Equal("skipped", stage.Status)
        Assert.NotEqual("passed", stage.Status)
    }

    /// The live library-parity path passes an explicit repository SDK pin to its runner.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func LibraryParity_RepositorySdkPinReachesRunner() {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let (app, outRoot) = NewMinimalLibraryApp("sdk-pin")
        let runner = FakeGsharpTestProjectRunner(GsharpTestRunResult.Unavailable("probe"))
        let options = PipelineOptions{
            GscPath: compiler,
            SdkVersion: "0.0.1-issue4631",
            OutputLayout: MigrationOutputLayout.Repository
        }
        let gsc = GscInvoker(compiler!!)
        let triage = TriageBuilder("sdk-pin", "2026-10-03T00:00:00Z", gsc.GetVersion(), app.Id)
        let context = StageExecutionContext(app, options, gsc, outRoot, triage)
        let outcome = await TestParityStage(runner).ExecuteAsync(context)
        Assert.Equal(StageStatus.Skipped, outcome.Status)
        Assert.NotNull(runner.Project)
        Assert.Equal(options.SdkVersion, runner.Project.SdkVersion)
    }

    /// A test double standing in for the real (cref:GsharpTestProjectRunner)
    /// (which shells out to real `dotnet test`): returns a fixed result
    /// without touching disk/process, mirroring the existing
    /// `CrashingIlVerifyRunner` pattern used for (cref:IlVerifyStage).
    private class FakeGsharpTestProjectRunner : GsharpTestProjectRunner {
        private let result GsharpTestRunResult

        init(result GsharpTestRunResult) {
            this.result = result
        }

        internal prop Project GsharpTestProject {
            get;
            private set;
        }

        override func Run(project GsharpTestProject, workDir string) GsharpTestRunResult {
            this.Project = project
            return this.result
        }
    }

    shared {
        private async func RunLibraryParityWithFakeResult(
            compiler string,
            fakeResult GsharpTestRunResult
        ) StageOutcome {
            let (app, outRoot) = NewMinimalLibraryApp("testparity-falsegreen")
            let fakeRunner = FakeGsharpTestProjectRunner(fakeResult)
            let stage = TestParityStage(fakeRunner)
            let options = PipelineOptions{GscPath: compiler}
            let gsc = GscInvoker(compiler)
            let triage = TriageBuilder("run_1", "2026-06-21T20:00:00Z", gsc.GetVersion(), app.Id)
            let context = StageExecutionContext(app, options, gsc, outRoot, triage)
            return await stage.ExecuteAsync(context)
        }

        /// Builds a corpus app whose sibling `.Tests` project loads and
        /// translates cleanly (a plain class/method, no xUnit attributes, so it
        /// never hits the "test-translation pending map-advanced" gate) so the
        /// library-parity path reaches (cref:GsharpTestProjectRunner.Run).
        private func NewMinimalLibraryApp(label string)(App CorpusApp, OutRoot string) {
            let testsDir = NewScratchDir(label)
            let testsProjectPath = Path.Combine(testsDir, "Minimal.Tests.csproj")
            File.WriteAllText(testsProjectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`)
            File.WriteAllText(
                Path.Combine(testsDir, "NoOpTests.cs"),
                "public class NoOpTests { public void DoesNothing() { } }"
            )
            let baselinePath = Path.Combine(testsDir, "baseline.tests.json")
            File.WriteAllText(
                baselinePath,
                "{\"schemaVersion\":\"1.0\",\"app\":\"Minimal.Tests\",\"framework\":\"xunit\"," +
                    "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}"
            )
            let app = CorpusApp(
                "test/MinimalLibrary",
                testsProjectPath,
                TargetKind.Library,
                testsProjectPath: testsProjectPath,
                testsBaselinePath: baselinePath
            )
            return (app, NewOutputRoot(label))
        }

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
