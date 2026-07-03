// <copyright file="TestParityStageFalseGreenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1749 mode 1: the stage-4 (ADR-0115 §C/§E)
/// library xUnit-parity path used to report <see cref="StageOutcome.Passed"/>
/// for both <see cref="GsharpTestRunStatus.Unavailable"/> (no locally-built SDK
/// — genuinely not verified) and <see cref="GsharpTestRunStatus.BuildFailed"/>
/// (the translated G# test project failed to build — a real regression, since
/// the same library green-built standalone <c>gsc</c> in stage 2). Both
/// silently reported "passed" in the machine-readable <see cref="StageResult"/>.
/// Now <c>Unavailable</c> maps to the distinct <see cref="StageStatus.Skipped"/>
/// ("not verified", never green) and <c>BuildFailed</c> maps to
/// <see cref="StageStatus.Failed"/> (a genuine regression).
/// </summary>
public class TestParityStageFalseGreenTests
{
    /// <summary>
    /// A locally-built-SDK-unavailable run must report <c>skipped</c>, never
    /// <c>passed</c>: "not verified" must not render as "verified green".
    /// </summary>
    [Fact]
    public async Task LibraryParity_SdkUnavailable_IsSkipped_NotPassed()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        StageOutcome outcome = await RunLibraryParityWithFakeResult(
            compiler, GsharpTestRunResult.Unavailable("no locally-built Gsharp.NET.Sdk nupkg"));

        Assert.Equal(StageStatus.Skipped, outcome.Status);
        Assert.NotEqual(StageStatus.Passed, outcome.Status);
        Assert.Empty(outcome.Artifacts);
    }

    /// <summary>
    /// A translated G# test project that fails to build is a genuine
    /// regression (the library already green-built standalone <c>gsc</c> in
    /// stage 2) and must FAIL the stage — never <c>passed</c>, and never
    /// silently downgraded to a skip either.
    /// </summary>
    [Fact]
    public async Task LibraryParity_BuildFailed_FailsStage_NotPassedOrSkipped()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        StageOutcome outcome = await RunLibraryParityWithFakeResult(
            compiler, GsharpTestRunResult.BuildFailed(1, "error GS9999: something broke"));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.NotEqual(StageStatus.Passed, outcome.Status);
        Assert.NotEqual(StageStatus.Skipped, outcome.Status);
        Assert.NotEmpty(outcome.Artifacts);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-BUILD-FAILED");
    }

    /// <summary>
    /// Wired through <see cref="MigrationPipeline"/> (not just the stage in
    /// isolation): a skipped stage-4 must show up as <c>"skipped"</c> in the
    /// machine-readable <see cref="StageResult"/>, not <c>"passed"</c> — the
    /// overall pipeline must never treat "not verified" as green.
    /// </summary>
    [Fact]
    public async Task Pipeline_SkippedStage_ReportsSkipped_NotPassed()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        (CorpusApp app, string outRoot) = NewMinimalLibraryApp("pipeline-skip");
        var fakeRunner = new FakeGsharpTestProjectRunner(
            GsharpTestRunResult.Unavailable("no locally-built Gsharp.NET.Sdk nupkg"));
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TestParityStage(fakeRunner) });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        StageResult stage = Assert.Single(appResult.Stages);

        Assert.Equal("skipped", stage.Status);
        Assert.NotEqual("passed", stage.Status);
    }

    private static async Task<StageOutcome> RunLibraryParityWithFakeResult(
        string compiler, GsharpTestRunResult fakeResult)
    {
        (CorpusApp app, string outRoot) = NewMinimalLibraryApp("testparity-falsegreen");
        var fakeRunner = new FakeGsharpTestProjectRunner(fakeResult);
        var stage = new TestParityStage(fakeRunner);

        var options = new PipelineOptions { GscPath = compiler };
        var gsc = new GscInvoker(compiler);
        var triage = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", gsc.GetVersion(), app.Id);
        var context = new StageExecutionContext(app, options, gsc, outRoot, triage);

        return await stage.ExecuteAsync(context);
    }

    /// <summary>
    /// Builds a corpus app whose sibling <c>.Tests</c> project loads and
    /// translates cleanly (a plain class/method, no xUnit attributes, so it
    /// never hits the "test-translation pending map-advanced" gate) so the
    /// library-parity path reaches <see cref="GsharpTestProjectRunner.Run"/>.
    /// </summary>
    private static (CorpusApp App, string OutRoot) NewMinimalLibraryApp(string label)
    {
        string testsDir = NewScratchDir(label);
        string testsProjectPath = Path.Combine(testsDir, "Minimal.Tests.csproj");
        File.WriteAllText(testsProjectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(testsDir, "NoOpTests.cs"),
            "public class NoOpTests { public void DoesNothing() { } }");

        string baselinePath = Path.Combine(testsDir, "baseline.tests.json");
        File.WriteAllText(
            baselinePath,
            "{\"schemaVersion\":\"1.0\",\"app\":\"Minimal.Tests\",\"framework\":\"xunit\"," +
            "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}");

        var app = new CorpusApp(
            "test/MinimalLibrary",
            testsProjectPath,
            TargetKind.Library,
            testsProjectPath: testsProjectPath,
            testsBaselinePath: baselinePath);

        return (app, NewOutputRoot(label));
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
    /// A test double standing in for the real <see cref="GsharpTestProjectRunner"/>
    /// (which shells out to real <c>dotnet test</c>): returns a fixed result
    /// without touching disk/process, mirroring the existing
    /// <c>CrashingIlVerifyRunner</c> pattern used for <see cref="IlVerifyStage"/>.
    /// </summary>
    private sealed class FakeGsharpTestProjectRunner : GsharpTestProjectRunner
    {
        private readonly GsharpTestRunResult result;

        public FakeGsharpTestProjectRunner(GsharpTestRunResult result)
        {
            this.result = result;
        }

        public override GsharpTestRunResult Run(GsharpTestProject project, string workDir) => this.result;
    }
}
