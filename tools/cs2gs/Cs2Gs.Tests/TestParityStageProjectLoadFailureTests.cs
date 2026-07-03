// <copyright file="TestParityStageProjectLoadFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Stage-level regression test for issue #1742 (review follow-up B1): the
/// library xUnit-parity path of <see cref="TestParityStage"/> translates the
/// sibling <c>.Tests</c> project via <c>CSharpProjectLoader.LoadProjectAsync</c>
/// but, before this fix, never checked whether that load even bound in C#. A
/// <c>.Tests</c> project that fails to load (missing SDK/targets, an
/// unresolvable <c>ProjectReference</c>, ...) must now FAIL the stage with the
/// load error surfaced, instead of being silently treated as "translation
/// pending" (a pass) or crashing further down the translate loop.
/// </summary>
public class TestParityStageProjectLoadFailureTests
{
    /// <summary>
    /// Directly exercises <see cref="TestParityStage.ExecuteAsync"/> (no need
    /// for the earlier stages to have run — the library path only requires
    /// <c>TestsProjectPath</c>/<c>TestsBaselinePath</c> to be eligible) against
    /// a <c>.Tests</c> project whose <c>ProjectReference</c> is unresolvable.
    /// </summary>
    [Fact]
    public async Task TestParityStage_TestsProjectFailsToLoad_FailsInsteadOfSkipping()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string testsDir = NewScratchDir("testparity-load-failure");
        File.WriteAllText(Path.Combine(testsDir, "Directory.Build.props"), "<Project></Project>");
        string testsProjectPath = Path.Combine(testsDir, "Broken.Tests.csproj");
        File.WriteAllText(testsProjectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\DoesNotExist\DoesNotExist.csproj"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(testsDir, "SomeTests.cs"),
            "public class SomeTests { public void T() { } }");

        string baselinePath = Path.Combine(testsDir, "baseline.tests.json");
        File.WriteAllText(
            baselinePath,
            "{\"schemaVersion\":\"1.0\",\"app\":\"Broken.Tests\",\"framework\":\"xunit\"," +
            "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}");

        string appRunDir = NewOutputRoot("testparity-load-failure");
        var app = new CorpusApp(
            "test/BrokenTestsLoad",
            Path.Combine(testsDir, "Broken.Tests.csproj"), // main project unused by the library path itself
            TargetKind.Library,
            testsProjectPath: testsProjectPath,
            testsBaselinePath: baselinePath);

        var options = new PipelineOptions { GscPath = compiler };
        var gsc = new GscInvoker(compiler);
        var triage = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", gsc.GetVersion(), app.Id);
        var context = new StageExecutionContext(app, options, gsc, appRunDir, triage);

        var stage = new TestParityStage();
        StageOutcome outcome = await stage.ExecuteAsync(context);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.NotEmpty(outcome.Artifacts);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "CS2GS0001");
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
}
