// <copyright file="TranslateStageNuGetAuditAdvisoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Follow-up to issue #2321: `CSharpProjectLoader` classifies a benign
/// NuGet audit vulnerability advisory (the NU1901-NU1904 shape) as an
/// informational `CS2GS0003` diagnostic instead of the fatal
/// `CS2GS0001` workspace-load failure, but nothing downstream of
/// (cref:TranslateStage) previously inspected
/// `LoadedCSharpProject.LoadDiagnostics` for it — the advisory loaded
/// successfully, yet was silently dropped from every generated migration
/// artifact. (cref:TranslateStage) must now record it (never fail the
/// stage on it) in the per-app `translate.log`, mirroring the existing
/// `TestParityStage.Note` / `test-parity.log` pattern.
open class TranslateStageNuGetAuditAdvisoryTests {
    /// A project whose only MSBuild workspace diagnostic is the benign NuGet
    /// audit advisory (here NU1903/high for the well-known
    /// `Newtonsoft.Json 12.0.1` advisory GHSA-5crp-9r3c-p9vr) must PASS
    /// the stage and still leave a visible, non-fatal trace in
    /// `<AppRunDir>/translate.log` naming the CS2GS0003 diagnostic.
    @Fact
    async func TranslateStage_NuGetAuditAdvisory_PassesAndIsNotedInTranslateLog() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-nuget-audit-advisory")
        let projectPath = Path.Combine(projectDir, "Vulnerable.csproj")
        WriteVulnerablePackageProject(projectDir, "Vulnerable.csproj")
        let outRoot = NewOutputRoot("translate-nuget-audit-advisory")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let app = CorpusApp("test/VulnerableAdvisory", projectPath, TargetKind.Exe)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.True(
            appResult.Succeeded,
            "A benign NuGet audit vulnerability advisory (NU1901-NU1904 shape) must not fail the Translate stage."
        )
        Assert.Equal("passed", appResult.Stages[0].Status)
        let translateLogs = Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)
        let translateLog = Assert.Single(translateLogs)
        let logContent = File.ReadAllText(translateLog)
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

        /// Issue #2321: writes a buildable console project referencing
        /// `Newtonsoft.Json 12.0.1`, whose known high-severity vulnerability
        /// (GHSA-5crp-9r3c-p9vr) NuGet reports as warning NU1903 during restore —
        /// the exact benign advisory shape this policy must exempt. An empty
        /// `Directory.Build.props` override stops MSBuild's directory search
        /// from climbing to this repo's own root props (which sets
        /// `TreatWarningsAsErrors`), matching the convention already used in
        /// `CSharpProjectLoaderDiagnosticsTests`.
        private func WriteVulnerablePackageProject(projectDir string, projectFileName string) {
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
            let projectPath = Path.Combine(projectDir, projectFileName)
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />
  </ItemGroup>
</Project>
`)
            File.WriteAllText(
                Path.Combine(projectDir, "Program.cs"),
                "public class Program { public static void Main() { } }"
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
