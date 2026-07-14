// <copyright file="TranslateStageNuGetAuditAdvisoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Follow-up to issue #2321: <c>CSharpProjectLoader</c> classifies a benign
/// NuGet audit vulnerability advisory (the NU1901-NU1904 shape) as an
/// informational <c>CS2GS0003</c> diagnostic instead of the fatal
/// <c>CS2GS0001</c> workspace-load failure, but nothing downstream of
/// <see cref="TranslateStage"/> previously inspected
/// <c>LoadedCSharpProject.LoadDiagnostics</c> for it — the advisory loaded
/// successfully, yet was silently dropped from every generated migration
/// artifact. <see cref="TranslateStage"/> must now record it (never fail the
/// stage on it) in the per-app <c>translate.log</c>, mirroring the existing
/// <c>TestParityStage.Note</c> / <c>test-parity.log</c> pattern.
/// </summary>
public class TranslateStageNuGetAuditAdvisoryTests
{
    /// <summary>
    /// A project whose only MSBuild workspace diagnostic is the benign NuGet
    /// audit advisory (here NU1903/high for the well-known
    /// <c>Newtonsoft.Json 12.0.1</c> advisory GHSA-5crp-9r3c-p9vr) must PASS
    /// the stage and still leave a visible, non-fatal trace in
    /// <c>&lt;AppRunDir&gt;/translate.log</c> naming the CS2GS0003 diagnostic.
    /// </summary>
    [Fact]
    public async Task TranslateStage_NuGetAuditAdvisory_PassesAndIsNotedInTranslateLog()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-nuget-audit-advisory");
        string projectPath = Path.Combine(projectDir, "Vulnerable.csproj");
        WriteVulnerablePackageProject(projectDir, "Vulnerable.csproj");

        string outRoot = NewOutputRoot("translate-nuget-audit-advisory");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });

        var app = new CorpusApp("test/VulnerableAdvisory", projectPath, TargetKind.Exe);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        Assert.True(
            appResult.Succeeded,
            "A benign NuGet audit vulnerability advisory (NU1901-NU1904 shape) must not fail the Translate stage.");
        Assert.Equal("passed", appResult.Stages[0].Status);

        string[] translateLogs = Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories);
        string translateLog = Assert.Single(translateLogs);
        string logContent = File.ReadAllText(translateLog);
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
    /// Issue #2321: writes a buildable console project referencing
    /// <c>Newtonsoft.Json 12.0.1</c>, whose known high-severity vulnerability
    /// (GHSA-5crp-9r3c-p9vr) NuGet reports as warning NU1903 during restore —
    /// the exact benign advisory shape this policy must exempt. An empty
    /// <c>Directory.Build.props</c> override stops MSBuild's directory search
    /// from climbing to this repo's own root props (which sets
    /// <c>TreatWarningsAsErrors</c>), matching the convention already used in
    /// <c>CSharpProjectLoaderDiagnosticsTests</c>.
    /// </summary>
    private static void WriteVulnerablePackageProject(string projectDir, string projectFileName)
    {
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, projectFileName);
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include=""Newtonsoft.Json"" Version=""12.0.1"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }");

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
