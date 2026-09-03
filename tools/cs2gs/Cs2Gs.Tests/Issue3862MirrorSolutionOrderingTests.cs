// <copyright file="Issue3862MirrorSolutionOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3862: the mirror must BE a repository before anything executes
/// inside it, not only after the run. Compile, ILVerify and <c>dotnet test</c>
/// all run in the destination tree during the per-app stage loop, and the code
/// they run probes the repository layout — <c>test/Sdk.Tests/RepoRoot.cs</c>
/// walks up from its output directory looking for a file literally named
/// <c>GSharp.sln</c>. Generating the mirrored solutions only after the stage
/// loop left every such probe looking at a root anchor that did not exist yet.
/// </summary>
public sealed class Issue3862MirrorSolutionOrderingTests : IDisposable
{
    private const string LegacySolution = """
        Microsoft Visual Studio Solution File, Format Version 12.00
        Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Widget", "src\Widget\Widget.csproj", "{2E0F0D1B-5E52-4A2A-9C7C-1E5B0F6A7B31}"
        EndProject
        Global
        	GlobalSection(SolutionConfigurationPlatforms) = preSolution
        		Debug|Any CPU = Debug|Any CPU
        	EndGlobalSection
        	GlobalSection(ProjectConfigurationPlatforms) = postSolution
        		{2E0F0D1B-5E52-4A2A-9C7C-1E5B0F6A7B31}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
        	EndGlobalSection
        EndGlobal

        """;

    private readonly string root;

    /// <summary>Initializes a new isolated test directory.</summary>
    public Issue3862MirrorSolutionOrderingTests()
    {
        this.root = Path.Combine(
            Path.GetTempPath(),
            "issue-3862-solution-ordering",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    /// <summary>Removes the isolated test directory.</summary>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// Every stage of every app observes the mirrored solution pair already on
    /// disk. This is the contract the migrated <c>test/Sdk.Tests</c> depends
    /// on: its tests run inside the mirror during stage 4 and resolve the
    /// repository root from the legacy <c>.sln</c>.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task MirroredSolutionsExist_BeforeAnyStageRunsInTheMirror()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            // The pipeline cannot run without a built gsc; a fabricated pass
            // would be worse than an honest no-op (issue #1749).
            return;
        }

        string source = Path.Combine(this.root, "source");
        string destination = Path.Combine(this.root, "destination");
        string projectDirectory = Path.Combine(source, "src", "Widget");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Widget.csproj");
        File.WriteAllText(
            projectPath,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>" +
            "<TargetFramework>net10.0</TargetFramework>" +
            "<Nullable>enable</Nullable>" +
            "</PropertyGroup></Project>");
        File.WriteAllText(
            Path.Combine(projectDirectory, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }");
        File.WriteAllText(Path.Combine(source, "Product.sln"), LegacySolution);

        var probe = new MirrorProbeStage(destination);
        var options = new PipelineOptions
        {
            GscPath = compiler,
            SourceRoot = source,
            OutputRoot = destination,
            ArtifactRoot = Path.Combine(this.root, "runs"),
            OutputLayout = MigrationOutputLayout.Repository,
            Config = "Release",
        };
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), probe });

        await pipeline.RunAsync(
            new[]
            {
                new CorpusApp(
                    "src/Widget/Widget.csproj",
                    projectPath,
                    TargetKind.Library,
                    relativeProjectPath: Path.Combine("src", "Widget", "Widget.csproj")),
            });

        // The probe ran (otherwise the assertion below is vacuous) and saw the
        // repository anchor both in its legacy and its converted spelling.
        Assert.NotEmpty(probe.Observations);
        Assert.All(probe.Observations, observation => Assert.True(
            observation.LegacySolutionExists && observation.ConvertedSolutionExists,
            $"stage observed sln={observation.LegacySolutionExists}, " +
            $"slnx={observation.ConvertedSolutionExists}"));

        // And the retargeting is the one #3772 established, not a stale copy.
        Assert.Contains(
            "Widget.gsproj",
            File.ReadAllText(Path.Combine(destination, "Product.sln")),
            StringComparison.Ordinal);
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
    /// Records what the mirror looked like at the moment a stage ran, which is
    /// the only place the ordering defect is observable.
    /// </summary>
    private sealed class MirrorProbeStage : IMigrationStage
    {
        private readonly string destinationRoot;

        internal MirrorProbeStage(string destinationRoot)
        {
            this.destinationRoot = destinationRoot;
            this.Observations = new List<MirrorObservation>();
        }

        public MigrationStageKind Kind => MigrationStageKind.Compile;

        internal List<MirrorObservation> Observations { get; }

        public Task<StageOutcome> ExecuteAsync(
            StageExecutionContext context,
            CancellationToken cancellationToken = default)
        {
            this.Observations.Add(new MirrorObservation(
                File.Exists(Path.Combine(this.destinationRoot, "Product.sln")),
                File.Exists(Path.Combine(this.destinationRoot, "Product.slnx"))));
            return Task.FromResult(StageOutcome.Passed());
        }
    }

    private readonly record struct MirrorObservation(
        bool LegacySolutionExists,
        bool ConvertedSolutionExists);
}
