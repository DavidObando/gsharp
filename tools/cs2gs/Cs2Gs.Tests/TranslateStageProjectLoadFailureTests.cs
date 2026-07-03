// <copyright file="TranslateStageProjectLoadFailureTests.cs" company="GSharp">
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
/// Stage-level regression tests for issue #1742 (review follow-up B1):
/// <c>LoadedCSharpProject.BoundWithoutErrors</c> load failures were previously
/// computed by <c>CSharpProjectLoader</c> but never checked by any pipeline
/// stage, so a project that failed to bind in C#
/// (missing SDK/targets, an unresolvable <c>ProjectReference</c>, ...) still
/// fell through to translation and produced only confusing downstream binding
/// noise. <see cref="TranslateStage"/> must now stop before translating any
/// document and surface the load failure as the stage's own artifact.
/// </summary>
public class TranslateStageProjectLoadFailureTests
{
    /// <summary>
    /// A project whose <c>ProjectReference</c> points at a file that does not
    /// exist is a classic MSBuild "soft fail" (see also
    /// <c>CSharpProjectLoaderDiagnosticsTests.LoadProjectAsync_SurfacesMSBuildWorkspaceLoadFailure</c>).
    /// Running <see cref="TranslateStage"/> alone over it must FAIL the stage
    /// with the <c>CS2GS0001</c> load-error diagnostic surfaced in a triage
    /// artifact, instead of proceeding to translate <c>Program.cs</c>.
    /// </summary>
    [Fact]
    public async Task TranslateStage_ProjectFailsToLoad_FailsBeforeTranslating()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-load-failure");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Broken.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\DoesNotExist\DoesNotExist.csproj"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }");

        string outRoot = NewOutputRoot("translate-load-failure");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });

        var app = new CorpusApp("test/BrokenLoad", projectPath, TargetKind.Exe);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        Assert.False(appResult.Succeeded, "A project that fails to load must not report stage success.");
        Assert.Single(appResult.Stages);
        Assert.Equal("failed", appResult.Stages[0].Status);
        Assert.NotEmpty(appResult.Artifacts);

        string[] triageFiles = Directory.GetFiles(outRoot, "*.json", SearchOption.AllDirectories)
            .Where(f => !Path.GetFileName(f).Equals("summary.json", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        string match = triageFiles.FirstOrDefault(f => File.ReadAllText(f).Contains("CS2GS0001"));
        Assert.NotNull(match);

        // No .gs file must have been emitted: the stage must stop before the
        // translate loop runs at all.
        string[] gsFiles = Directory.GetFiles(outRoot, "*.gs", SearchOption.AllDirectories);
        Assert.Empty(gsFiles);
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
