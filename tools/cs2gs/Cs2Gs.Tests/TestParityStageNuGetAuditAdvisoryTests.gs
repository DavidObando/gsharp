// <copyright file="TestParityStageNuGetAuditAdvisoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Threading.Tasks
import Xunit

/// Follow-up to issue #2321: the library xUnit-parity path of
/// (cref:TestParityStage) loads the sibling `.Tests` project via
/// `CSharpProjectLoader.LoadProjectAsync` — a THIRD, separate load call
/// site (distinct from (cref:TranslateStage)'s primary app load) that
/// can also surface a benign NuGet audit vulnerability advisory
/// (`CS2GS0003`). Before this fix nothing carried that diagnostic
/// forward from `TranslateProjectAsync` to the caller, so it was loaded
/// successfully yet silently dropped. It must now be recorded (never fail the
/// stage on it) in the per-app `test-parity.log`, via the existing
/// `Note` helper.
open class TestParityStageNuGetAuditAdvisoryTests {
    /// A `.Tests` project whose only MSBuild workspace diagnostic is the
    /// benign NuGet audit advisory (here NU1903/high for the well-known
    /// `Newtonsoft.Json 12.0.1` advisory GHSA-5crp-9r3c-p9vr) must not
    /// fail the stage, and must leave a visible, non-fatal trace naming the
    /// CS2GS0003 diagnostic in `<AppRunDir>/test-parity.log`.
    @Fact
    async func TestParityStage_TestsProjectNuGetAuditAdvisory_DoesNotFailAndIsNoted() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let testsDir = NewScratchDir("testparity-nuget-audit-advisory")
        let testsProjectPath = Path.Combine(testsDir, "Vulnerable.Tests.csproj")
        WriteVulnerablePackageProject(testsDir, "Vulnerable.Tests.csproj", "SomeTests.cs")
        let baselinePath = Path.Combine(testsDir, "baseline.tests.json")
        File.WriteAllText(
            baselinePath,
            "{\"schemaVersion\":\"1.0\",\"app\":\"Vulnerable.Tests\",\"framework\":\"xunit\"," +
                "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}"
        )
        let appRunDir = NewOutputRoot("testparity-nuget-audit-advisory")
        let app = CorpusApp(
            "test/VulnerableTestsAdvisory",
            testsProjectPath,
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
        // The advisory itself must never cause a CS2GS0001-style load failure
        // (whatever else may or may not pass/skip/fail below it in this
        // minimal harness — e.g. the deliberately-empty library project this
        // test does not populate — is unrelated to the policy under test).
        Assert.DoesNotContain(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "CS2GS0001")
        let logPath = Path.Combine(appRunDir, "test-parity.log")
        Assert.True(File.Exists(logPath), "Expected test-parity.log to be written.")
        let logContent = File.ReadAllText(logPath)
        Assert.Contains("CS2GS0003", logContent)
        Assert.Contains("Newtonsoft.Json", logContent)
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

        /// Issue #2321: writes a buildable `.Tests`-shaped project referencing
        /// `Newtonsoft.Json 12.0.1`, whose known high-severity vulnerability
        /// (GHSA-5crp-9r3c-p9vr) NuGet reports as warning NU1903 during restore —
        /// the exact benign advisory shape this policy must exempt. An empty
        /// `Directory.Build.props` override stops MSBuild's directory search
        /// from climbing to this repo's own root props (which sets
        /// `TreatWarningsAsErrors`), matching the convention already used in
        /// `CSharpProjectLoaderDiagnosticsTests`.
        private func WriteVulnerablePackageProject(projectDir string, projectFileName string, sourceFileName string) {
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
            let projectPath = Path.Combine(projectDir, projectFileName)
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />
  </ItemGroup>
</Project>
`)
            File.WriteAllText(
                Path.Combine(projectDir, sourceFileName),
                "public class SomeTests { public void T() { } }"
            )
            // Issue #2321: the advisory only surfaces through MSBuildWorkspace once
            // the project has an on-disk obj/project.assets.json to replay — same
            // as any already-restored/built app cs2gs is pointed at in practice.
            // Run a real `dotnet restore` here to reproduce that precondition.
            RunDotnetRestore(projectPath)
        }

        private func RunDotnetRestore(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet", "restore \"$projectPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            // `dotnet restore` itself exits 0 here because the vulnerability is a
            // plain warning (not elevated) under the empty Directory.Build.props
            // override — a non-zero exit means something unrelated broke restore
            // (e.g. no network access to nuget.org), which every assertion below
            // would otherwise misattribute to the policy under test.
            Assert.True(
                process!!.ExitCode == 0,
                (
                    `Prerequisite ` +
                        "\u0060" +
                        `dotnet restore` +
                        "\u0060" +
                        ` failed (exit ` +
                        "${process!!.ExitCode}" +
                        `); cannot exercise the NuGet audit advisory path.
stdout:
` +
                        "$stdout" +
                        `
stderr:
` +
                        "$stderr"
                )
            )
        }
    }
}
