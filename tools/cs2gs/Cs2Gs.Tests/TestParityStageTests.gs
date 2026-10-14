// <copyright file="TestParityStageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// End-to-end tests for stage 4 (ADR-0115 §C/§E) over the real `L1-Console`
/// corpus app: the stdout-parity GREEN path (L1 is the first app green across all
/// four stages) and the stdout-mismatch capture path (a deliberately-wrong golden
/// yields a `test-parity-failure` artifact). Both gate on the `gsc`
/// compiler artifact being present, returning early otherwise like the other
/// pipeline e2e tests.
@Collection("IlVerifyPipeline")
open class TestParityStageTests {
    /// Running the pipeline over `corpus/L1-Console` passes all FOUR stages —
    /// translate, compile, ilverify, AND test-parity (stdout matches the golden) —
    /// with zero artifacts. This is the milestone: L1 is green end-to-end.
    @Fact
    async func L1_AllFourStages_AreGreen_WithStdoutParity() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("l1-testparity-green")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options)
        let l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(l1)
        let result = await pipeline.RunAsync([]CorpusApp{l1})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "L1 must migrate green through stage 4 (test-parity). Failure category: " +
                (app.FailureCategory ?? "<none>") +
                "; artifacts: " +
                string.Join(", ", app.Artifacts)
        )
        Assert.Empty(app.Artifacts)
        Assert.Equal(4, app.Stages.Count)
        Assert.All(app.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
        Assert.Equal("test-parity", app.Stages[3].Stage)
    }

    /// When the migrated program's stdout diverges from the golden, stage 4 yields
    /// a single `test-parity-failure` artifact with the `STDOUT-MISMATCH`
    /// diagnostic id, labels `Oats` + `bug`, and a stable `sha256:`
    /// fingerprint. Exercised by pointing L1 at a deliberately-wrong golden copy.
    @Fact
    async func L1_WrongGolden_ProducesTestParityFailureArtifact() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let original = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(original)
        let outRoot = NewOutputRoot("l1-testparity-mismatch")
        let wrongGolden = Path.Combine(outRoot, "wrong.stdout.golden")
        File.WriteAllText(wrongGolden, "this is definitely not the real L1 output\n")
        let tampered = CorpusApp(
            original.Id,
            original.ProjectPath,
            original.TargetKind,
            stdoutGolden: wrongGolden,
            referencedAssemblies: original.ReferencedAssemblies
        )
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options)
        let result = await pipeline.RunAsync([]CorpusApp{tampered})
        let app = Assert.Single(result.Apps)
        Assert.False(app.Succeeded)
        Assert.Equal("test-parity-failure", app.FailureCategory)
        let files = Directory.GetFiles(outRoot, "test-parity-*.json", SearchOption.AllDirectories)
        Assert.NotEmpty(files)
        let match string? = files.FirstOrDefault((f string) -> File.ReadAllText(f).Contains("STDOUT-MISMATCH"))
        Assert.NotNull(match)
        let json = File.ReadAllText(match!!)
        Assert.Contains("test-parity-failure", json)
        Assert.Contains("\"Oats\"", json)
        Assert.Contains("\"bug\"", json)
        Assert.Contains("sha256:", json)
        Assert.Contains("GSHARP_UPDATE_GOLDENS=1", json)
        Assert.True(File.Exists(wrongGolden + ".actual"))
    }

    shared {
        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
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

        private func ResolveCorpusDir() string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus")
    }
}
