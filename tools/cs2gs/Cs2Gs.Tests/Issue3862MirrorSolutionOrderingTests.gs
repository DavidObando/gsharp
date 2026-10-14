// <copyright file="Issue3862MirrorSolutionOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3862: the mirror must BE a repository before anything executes
/// inside it, not only after the run. Compile, ILVerify and `dotnet test`
/// all run in the destination tree during the per-app stage loop, and the code
/// they run probes the repository layout — `test/Sdk.Tests/RepoRoot.cs`
/// walks up from its output directory looking for a file literally named
/// `GSharp.sln`. Generating the mirrored solutions only after the stage
/// loop left every such probe looking at a root anchor that did not exist yet.
class Issue3862MirrorSolutionOrderingTests : IDisposable {
    private let root string

    /// Initializes a new isolated test directory.
    init() {
        this.root = Path.Combine(Path.GetTempPath(), "issue-3862-solution-ordering", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.root)
    }

    /// Removes the isolated test directory.
    func Dispose() {
        try {
            Directory.Delete(this.root, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// Every stage of every app observes the mirrored solution pair already on
    /// disk. This is the contract the migrated `test/Sdk.Tests` depends
    /// on: its tests run inside the mirror during stage 4 and resolve the
    /// repository root from the legacy `.sln`.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func MirroredSolutionsExist_BeforeAnyStageRunsInTheMirror() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            // The pipeline cannot run without a built gsc; a fabricated pass
            // would be worse than an honest no-op (issue #1749).
            return
        }
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        let projectDirectory = Path.Combine(source, "src", "Widget")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Widget.csproj")
        File.WriteAllText(
            projectPath,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>" +
                "<TargetFramework>net10.0</TargetFramework>" +
                "<Nullable>enable</Nullable>" +
                "</PropertyGroup></Project>"
        )
        File.WriteAllText(
            Path.Combine(projectDirectory, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        File.WriteAllText(Path.Combine(source, "Product.sln"), LegacySolution)
        let probe = MirrorProbeStage(destination)
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: source,
            OutputRoot: destination,
            ArtifactRoot: Path.Combine(this.root, "runs"),
            OutputLayout: MigrationOutputLayout.Repository,
            Config: "Release"
        }
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), probe})
        await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp(
                    "src/Widget/Widget.csproj",
                    projectPath,
                    TargetKind.Library,
                    relativeProjectPath: Path.Combine("src", "Widget", "Widget.csproj")
                )
            }
        )
        // The probe ran (otherwise the assertion below is vacuous) and saw the
        // repository anchor both in its legacy and its converted spelling.
        Assert.NotEmpty(probe.Observations)
        Assert.All(
            probe.Observations,
            (observation MirrorObservation) -> Assert.True(
                observation.LegacySolutionExists && observation.ConvertedSolutionExists,
                "stage observed sln=${observation.LegacySolutionExists}, " +
                    "slnx=${observation.ConvertedSolutionExists}"
            )
        )
        // And the retargeting is the one #3772 established, not a stale copy.
        Assert.Contains(
            "Widget.gsproj",
            File.ReadAllText(Path.Combine(destination, "Product.sln")),
            StringComparison.Ordinal
        )
    }

    /// Records what the mirror looked like at the moment a stage ran, which is
    /// the only place the ordering defect is observable.
    private class MirrorProbeStage : IMigrationStage {
        private let destinationRoot string

        internal init(destinationRoot string) {
            this.destinationRoot = destinationRoot
            this.Observations = List[MirrorObservation]()
        }

        prop Kind MigrationStageKind -> MigrationStageKind.Compile

        internal prop Observations List[MirrorObservation] {
            get;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] {
            this.Observations.Add(
                MirrorObservation(
                    File.Exists(Path.Combine(this.destinationRoot, "Product.sln")),
                    File.Exists(Path.Combine(this.destinationRoot, "Product.slnx"))
                )
            )
            return Task.FromResult(StageOutcome.Passed())
        }
    }

    private data struct MirrorObservation(LegacySolutionExists bool, ConvertedSolutionExists bool) : IEquatable[
        MirrorObservation
    ] { }

    shared {
        private const LegacySolution string = `Microsoft Visual Studio Solution File, Format Version 12.00
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
`

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
