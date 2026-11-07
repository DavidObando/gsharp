// <copyright file="Issue4853StopAfterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.Json
import System.Threading.Tasks
import Xunit

/// Issue #4853: `cs2gs migrate --stop-after` selects a stage prefix.
class Issue4853StopAfterTests : IDisposable {
    private let root string = Path.Combine(Path.GetTempPath(), "cs2gs-4853-" + Guid.NewGuid().ToString("N"))

    func Dispose() {
        try {
            Directory.Delete(this.root, recursive: true)
        } catch (DirectoryNotFoundException) { } catch (IOException) { }
    }

    @Theory
    @InlineData("translate", []string{"translate"})
    @InlineData("compile", []string{"translate", "compile"})
    @InlineData("ilverify", []string{"translate", "compile", "ilverify"})
    @InlineData("test-parity", []string{"translate", "compile", "ilverify", "test-parity"})
    func StopAfter_ParsesToTheStagePrefix(name string, expected[]string) {
        let parsed object? = Parse("--corpus", "/nonexistent-corpus", "--stop-after", name)
        Assert.NotNull(parsed)
        let stopAfter = MigrationStageKind?(parsed!!.GetType().GetProperty("StopAfter")!!.GetValue(parsed))
        Assert.Equal(
            expected,
            MigrationPipeline
                .StagesThrough(stopAfter!!)
                .Select((stage IMigrationStage) -> TriageSerialization.StageName(stage.Kind))
                .ToArray()
        )
    }

    @Fact
    func StopAfter_DefaultsToAllStages() {
        let parsed object? = Parse("--corpus", "/nonexistent-corpus")
        Assert.NotNull(parsed)
        Assert.Null(MigrationStageKind?(parsed!!.GetType().GetProperty("StopAfter")!!.GetValue(parsed)))
    }

    @Theory
    @InlineData("compile", true)
    @InlineData("ilverify", true)
    @InlineData("test-parity", true)
    @InlineData("translate", false)
    func TranslateOnly_ConflictsWithALaterStopAfter(stage string, rejected bool) {
        let parsed object? = Parse("--corpus", "/nonexistent-corpus", "--translate-only", "--stop-after", stage)
        Assert.Equal(rejected, parsed == nil)
    }

    @Fact
    func StopAfter_RejectsAnUnknownStage() {
        Assert.Null(Parse("--corpus", "/nonexistent-corpus", "--stop-after", "polish"))
    }

    /// The real driver: `migrate --stop-after translate` runs exactly the
    /// translate stage for each app (a regression that ignores the option would
    /// also record compile and later stages).
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Migrate_StopAfterTranslate_RunsOnlyTheTranslateStage() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let source = Path.Combine(this.root, "source", "src", "Widget")
        Directory.CreateDirectory(source)
        File.WriteAllText(
            Path.Combine(source, "Widget.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        File.WriteAllText(
            Path.Combine(source, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        let artifacts = Path.Combine(this.root, "runs")
        let originalOut = Console.Out
        let capturedOut = StringWriter()
        Console.SetOut(capturedOut)
        var exit int32
        try {
            exit = await Program.Main(
                []string{
                    "migrate",
                    "--corpus",
                    Path.Combine(this.root, "source"),
                    "--out",
                    Path.Combine(this.root, "destination"),
                    "--artifacts",
                    artifacts,
                    "--gsc",
                    compiler,
                    "--config",
                    "Release",
                    "--stop-after",
                    "translate"
                }
            )
        } finally {
            Console.SetOut(originalOut)
        }
        Assert.Contains("partial run (--stop-after translate)", capturedOut.ToString(), StringComparison.Ordinal)
        let runJson = Directory.GetFiles(artifacts, "run.json", SearchOption.AllDirectories).Single()
        let result RunResult? = JsonSerializer.Deserialize[RunResult](
            File.ReadAllText(runJson),
            TriageSerialization.Options
        )
        let app = Assert.Single(result!!.Apps)
        Assert.Equal([]string{"translate"}, result!!.RequestedStages)
        Assert.Equal([]string{"translate"}, app.Stages.Select((stage StageResult) -> stage.Stage).ToArray())
        Assert.True(app.Succeeded)
        Assert.True(app.Unverified)
        Assert.True(result!!.Unverified)
        Assert.Equal(0, exit)
    }

    /// Issue #4883: `migrate --stop-after compile` runs translate and compile
    /// (stopping before ilverify/test-parity), and `--baseline --baseline-strict`
    /// does not report open baseline entries from unexecuted later stages as stale.
    @Fact
    async func Migrate_StopAfterCompile_RunsTranslateAndCompile_AndIgnoresLaterStageBaselineEntries() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let source = Path.Combine(this.root, "source", "src", "Widget")
        Directory.CreateDirectory(source)
        File.WriteAllText(
            Path.Combine(source, "Widget.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        File.WriteAllText(
            Path.Combine(source, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        let baselinePath = Path.Combine(this.root, "gaps.json")
        let ledger = GapLedger(
            List[GapLedgerEntry]{
                GapLedgerEntry{
                    Fingerprint: "sha256:later-stage-entry",
                    Status: GapLedgerEntry.StatusOpen,
                    Issue: 4883,
                    Title: "test-parity gap",
                    Stage: "test-parity",
                    FirstSeenRun: "run-1",
                    Apps: List[string]{"corpus/Widget"}
                }
            }
        )
        ledger.Save(baselinePath)
        let destination = Path.Combine(this.root, "destination-compile")
        let originalOut = Console.Out
        let capturedOut = StringWriter()
        Console.SetOut(capturedOut)
        var exit int32
        try {
            exit = await Program.Main(
                []string{
                    "migrate",
                    "--diagnostic-run",
                    "--corpus",
                    Path.Combine(this.root, "source"),
                    "--out",
                    destination,
                    "--gsc",
                    compiler,
                    "--config",
                    "Release",
                    "--no-via-sdk",
                    "--stop-after",
                    "compile",
                    "--baseline",
                    baselinePath,
                    "--baseline-strict"
                }
            )
        } finally {
            Console.SetOut(originalOut)
        }
        let stdout = capturedOut.ToString()
        Assert.Contains("partial run (--stop-after compile)", stdout, StringComparison.Ordinal)
        Assert.DoesNotContain("STALE", stdout, StringComparison.Ordinal)
        Assert.DoesNotContain("UNVERIFIED", stdout, StringComparison.Ordinal)
        let runJson = Directory.GetFiles(destination, "run.json", SearchOption.AllDirectories).Single()
        let result RunResult? = JsonSerializer.Deserialize[RunResult](
            File.ReadAllText(runJson),
            TriageSerialization.Options
        )
        let app = Assert.Single(result!!.Apps)
        Assert.Equal([]string{"translate", "compile"}, app.Stages.Select((stage StageResult) -> stage.Stage).ToArray())
        Assert.True(app.Succeeded)
        Assert.True(app.Unverified)
        Assert.Equal(0, exit)
    }

    /// Issue #4883 (review): when a known baseline translation gap causes
    /// `translate` to fail under `--stop-after compile --baseline`, the skipped
    /// `compile` stage on that failed app must not trigger an `UNVERIFIED` failure.
    @Fact
    async func Migrate_StopAfterCompile_WithBaselinedTranslateGap_DoesNotReportUnverified() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let source = Path.Combine(this.root, "source-gap", "src", "Broken")
        Directory.CreateDirectory(source)
        File.WriteAllText(
            Path.Combine(source, "Broken.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AllowUnsafeBlocks>true</AllowUnsafeBlocks></PropertyGroup></Project>"
        )
        File.WriteAllText(
            Path.Combine(source, "Broken.cs"),
            "namespace Broken { public record struct BadRecord { public int X; public BadRecord(int x) { X = x; if (x < 0) X = -x; } } }"
        )
        let goodSource = Path.Combine(this.root, "source-gap", "src", "Widget")
        Directory.CreateDirectory(goodSource)
        File.WriteAllText(
            Path.Combine(goodSource, "Widget.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        File.WriteAllText(
            Path.Combine(goodSource, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        let firstOut = Path.Combine(this.root, "destination-gap-1")
        let _ = await Program.Main(
            []string{
                "migrate",
                "--diagnostic-run",
                "--corpus",
                Path.Combine(this.root, "source-gap"),
                "--out",
                firstOut,
                "--gsc",
                compiler,
                "--config",
                "Release",
                "--no-via-sdk",
                "--stop-after",
                "compile"
            }
        )
        let firstRunDir = Path.GetDirectoryName(
            Directory.GetFiles(firstOut, "run.json", SearchOption.AllDirectories).Single()
        )!!
        let discoveredArtifacts = GapLedger.LoadRunArtifacts(firstRunDir)
        let artifact = Assert.Single(discoveredArtifacts)
        let baselinePath = Path.Combine(this.root, "gaps-translate.json")
        let ledger = GapLedger(
            List[GapLedgerEntry]{
                GapLedgerEntry{
                    Fingerprint: artifact.Fingerprint,
                    Status: GapLedgerEntry.StatusOpen,
                    Issue: 4883,
                    Title: "known translate gap",
                    Stage: artifact.Stage,
                    FirstSeenRun: "run-1",
                    Apps: List[string]{"corpus/Broken"}
                },
                GapLedgerEntry{
                    Fingerprint: "sha256:skipped-compile-entry",
                    Status: GapLedgerEntry.StatusOpen,
                    Issue: 4883,
                    Title: "open compile gap on skipped stage",
                    Stage: "compile",
                    FirstSeenRun: "run-1",
                    Apps: List[string]{"corpus/Broken"}
                }
            }
        )
        ledger.Save(baselinePath)
        let secondOut = Path.Combine(this.root, "destination-gap-2")
        let originalOut = Console.Out
        let capturedOut = StringWriter()
        Console.SetOut(capturedOut)
        var exit int32
        try {
            exit = await Program.Main(
                []string{
                    "migrate",
                    "--diagnostic-run",
                    "--corpus",
                    Path.Combine(this.root, "source-gap"),
                    "--out",
                    secondOut,
                    "--gsc",
                    compiler,
                    "--config",
                    "Release",
                    "--no-via-sdk",
                    "--stop-after",
                    "compile",
                    "--baseline",
                    baselinePath,
                    "--baseline-strict"
                }
            )
        } finally {
            Console.SetOut(originalOut)
        }
        let stdout = capturedOut.ToString()
        Assert.DoesNotContain("UNVERIFIED", stdout, StringComparison.Ordinal)
        Assert.DoesNotContain("STALE", stdout, StringComparison.Ordinal)
        Assert.Equal(0, exit)
    }

    shared {
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

        private func Parse(args ...string) object? {
            let parse MethodInfo? = typeof(Program).GetMethod(
                "ParseMigrateArgs",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(parse)
            return parse!!.Invoke(nil, []object{args, false})
        }
    }
}
