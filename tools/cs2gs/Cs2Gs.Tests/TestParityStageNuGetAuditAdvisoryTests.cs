// <copyright file="TestParityStageNuGetAuditAdvisoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Follow-up to issue #2321: the library xUnit-parity path of
/// <see cref="TestParityStage"/> loads the sibling <c>.Tests</c> project via
/// <c>CSharpProjectLoader.LoadProjectAsync</c> — a THIRD, separate load call
/// site (distinct from <see cref="TranslateStage"/>'s primary app load) that
/// can also surface a benign NuGet audit vulnerability advisory
/// (<c>CS2GS0003</c>). Before this fix nothing carried that diagnostic
/// forward from <c>TranslateProjectAsync</c> to the caller, so it was loaded
/// successfully yet silently dropped. It must now be recorded (never fail the
/// stage on it) in the per-app <c>test-parity.log</c>, via the existing
/// <c>Note</c> helper.
/// </summary>
public class TestParityStageNuGetAuditAdvisoryTests
{
    /// <summary>
    /// A <c>.Tests</c> project whose only MSBuild workspace diagnostic is the
    /// benign NuGet audit advisory (here NU1903/high for the well-known
    /// <c>Newtonsoft.Json 12.0.1</c> advisory GHSA-5crp-9r3c-p9vr) must not
    /// fail the stage, and must leave a visible, non-fatal trace naming the
    /// CS2GS0003 diagnostic in <c>&lt;AppRunDir&gt;/test-parity.log</c>.
    /// </summary>
    [Fact]
    public async Task TestParityStage_TestsProjectNuGetAuditAdvisory_DoesNotFailAndIsNoted()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string testsDir = NewScratchDir("testparity-nuget-audit-advisory");
        string testsProjectPath = Path.Combine(testsDir, "Vulnerable.Tests.csproj");
        WriteVulnerablePackageProject(testsDir, "Vulnerable.Tests.csproj", "SomeTests.cs");

        string baselinePath = Path.Combine(testsDir, "baseline.tests.json");
        File.WriteAllText(
            baselinePath,
            "{\"schemaVersion\":\"1.0\",\"app\":\"Vulnerable.Tests\",\"framework\":\"xunit\"," +
            "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}");

        string appRunDir = NewOutputRoot("testparity-nuget-audit-advisory");
        var app = new CorpusApp(
            "test/VulnerableTestsAdvisory",
            testsProjectPath, // main project unused by the library path itself
            TargetKind.Library,
            testsProjectPath: testsProjectPath,
            testsBaselinePath: baselinePath);

        var options = new PipelineOptions { GscPath = compiler };
        var gsc = new GscInvoker(compiler);
        var triage = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", gsc.GetVersion(), app.Id);
        var context = new StageExecutionContext(app, options, gsc, appRunDir, triage);

        var stage = new TestParityStage();
        StageOutcome outcome = await stage.ExecuteAsync(context);

        // The advisory itself must never cause a CS2GS0001-style load failure
        // (whatever else may or may not pass/skip/fail below it in this
        // minimal harness — e.g. the deliberately-empty library project this
        // test does not populate — is unrelated to the policy under test).
        Assert.DoesNotContain(outcome.Artifacts, a => a.Diagnostic.Id == "CS2GS0001");

        string logPath = Path.Combine(appRunDir, "test-parity.log");
        Assert.True(File.Exists(logPath), "Expected test-parity.log to be written.");
        string logContent = File.ReadAllText(logPath);
        Assert.Contains("CS2GS0003", logContent);
        Assert.Contains("Newtonsoft.Json", logContent);
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>
    /// Issue #2321: writes a buildable <c>.Tests</c>-shaped project referencing
    /// <c>Newtonsoft.Json 12.0.1</c>, whose known high-severity vulnerability
    /// (GHSA-5crp-9r3c-p9vr) NuGet reports as warning NU1903 during restore —
    /// the exact benign advisory shape this policy must exempt. An empty
    /// <c>Directory.Build.props</c> override stops MSBuild's directory search
    /// from climbing to this repo's own root props (which sets
    /// <c>TreatWarningsAsErrors</c>), matching the convention already used in
    /// <c>CSharpProjectLoaderDiagnosticsTests</c>.
    /// </summary>
    private static void WriteVulnerablePackageProject(string projectDir, string projectFileName, string sourceFileName)
    {
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, projectFileName);
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include=""Newtonsoft.Json"" Version=""12.0.1"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(projectDir, sourceFileName),
            "public class SomeTests { public void T() { } }");

        // Issue #2321: the advisory only surfaces through MSBuildWorkspace once
        // the project has an on-disk obj/project.assets.json to replay — same
        // as any already-restored/built app cs2gs is pointed at in practice.
        // Run a real `dotnet restore` here to reproduce that precondition.
        RunDotnetRestore(projectPath);
    }

    private static void RunDotnetRestore(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet", $"restore \"{projectPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        // `dotnet restore` itself exits 0 here because the vulnerability is a
        // plain warning (not elevated) under the empty Directory.Build.props
        // override — a non-zero exit means something unrelated broke restore
        // (e.g. no network access to nuget.org), which every assertion below
        // would otherwise misattribute to the policy under test.
        Assert.True(
            process.ExitCode == 0,
            $"Prerequisite `dotnet restore` failed (exit {process.ExitCode}); cannot exercise the NuGet audit advisory path.\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }
}
