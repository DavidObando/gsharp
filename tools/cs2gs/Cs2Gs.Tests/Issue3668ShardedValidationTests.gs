// <copyright file="Issue3668ShardedValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.Json
import Xunit

/// Issue #3668: the self-migration gate now runs as ONE whole-repository
/// translate pass plus N independent validation shards. These tests pin the
/// three pieces that make that split safe:
/// - the (cref:ValidationManifest) hand-off carries exactly the translate-derived state stages 2–4
/// consume, and rehydrates it from a migrated tree;
/// - shard selection narrows what is EXECUTED, never what is discovered (`--exclude` must stay
/// identical across jobs, or reference resolution breaks and phantom cascades appear);
/// - the merge reconstructs the same per-app verdicts a single whole run would have produced, and
/// refuses to silently drop an app.
open class Issue3668ShardedValidationTests {
    /// The manifest round-trips the translate-derived state and rehydrates the
    /// emitted G# set by re-reading the migrated tree — so a shard sees the
    /// same `EmittedFiles` the whole run's compile stage would.
    @Fact
    func ManifestRoundTripsTranslateDerivedState() {
        using let temp = Issue3668ShardedValidationTests.TempDirectory()
        let migrated = Path.Combine(temp.Path, "migrated")
        let projectDir = Path.Combine(migrated, "src", "Lib")
        Directory.CreateDirectory(projectDir)
        let gsPath = Path.Combine(projectDir, "Widget.gs")
        File.WriteAllText(gsPath, "package Lib\n")
        let reference = Path.Combine(temp.Path, "Some.Package.dll")
        File.WriteAllText(reference, string.Empty)
        let sourceDirectory = Path.Combine(temp.Path, "src", "Lib")
        Directory.CreateDirectory(sourceDirectory)
        File.WriteAllText(Path.Combine(sourceDirectory, "Widget.cs"), "namespace Lib {}")
        let app = CorpusApp("src/Lib/Lib.csproj", Path.Combine(sourceDirectory, "Lib.csproj"), TargetKind.Library)
        let options = PipelineOptions{OutputLayout: MigrationOutputLayout.Repository, SourceRoot: temp.Path}
        let context = StageExecutionContext(
            app,
            options,
            NullGsc(),
            projectDir,
            Path.Combine(temp.Path, "artifacts"),
            TriageBuilder("run", "ts", "gsc", app.Id)
        )
        context.IsTestProject = true
        context.IsAnalyzerProject = true
        context.IsAnalyzerTestProject = true
        context.RootNamespace = "Lib"
        context.AssemblyName = "Lib"
        context.GeneratedFriendAssemblies.Add("Lib.Tests")
        context.ExternalReferencePaths.Add(reference)
        context.ExternalReferencePaths.Add(Path.Combine(temp.Path, "Absent.dll"))
        context.EmittedFiles.Add(
            EmittedGsFile(gsPath, "src_Lib/Widget.gs", Path.Combine(sourceDirectory, "Widget.cs"), "package Lib\n")
        )
        let artifactDir = Path.Combine(temp.Path, "artifacts")
        ValidationManifest.Write(ValidationManifest.Capture(context, translated: true, migrated), artifactDir)
        let read = ValidationManifest.Read(artifactDir)!!
        Assert.NotNull(read)
        Assert.True(read.Translated)
        Assert.Equal("src/Lib/Lib.csproj", read.AppId)
        // Emitted paths are stored relative to the migrated tree so the tree
        // can be re-rooted onto a shard runner.
        Assert.Equal("src/Lib/Widget.gs", Assert.Single(read.EmittedFiles).Path)
        Assert.Equal("src/Lib/Widget.cs", Assert.Single(read.EmittedFiles).RelativeCsPath)
        Assert.Equal("src/Lib/Lib.csproj", read.SourceProjectPath)
        Assert.Equal(CanonicalRootPath.Resolve(temp.Path), read.SourceRoot)
        let rehydrated = StageExecutionContext(
            app,
            PipelineOptions{OutputLayout: MigrationOutputLayout.Repository, SourceRoot: temp.Path},
            NullGsc(),
            projectDir,
            artifactDir,
            TriageBuilder("run2", "ts", "gsc", app.Id)
        )
        read.Hydrate(rehydrated, migrated)
        Assert.True(rehydrated.IsTestProject)
        Assert.True(rehydrated.IsAnalyzerProject)
        Assert.True(rehydrated.IsAnalyzerTestProject)
        Assert.Equal("Lib", rehydrated.RootNamespace)
        Assert.Equal("Lib", rehydrated.AssemblyName)
        Assert.Equal([]string{"Lib.Tests"}, rehydrated.GeneratedFriendAssemblies.ToArray())
        // A package path the shard cannot see is dropped rather than handed to
        // ilverify as a dangling -r; ilverify scans the output directory anyway.
        Assert.Equal([]string{reference}, rehydrated.ExternalReferencePaths.ToArray())
        let emitted = Assert.Single(rehydrated.EmittedFiles)
        Assert.Equal(Path.GetFullPath(gsPath), Path.GetFullPath(emitted.GsPath!!))
        Assert.Equal("src_Lib/Widget.gs", emitted.RelativeGsPath)
        Assert.Equal("package Lib\n", emitted.GSharpSource)
    }

    /// The manifest is looked up by the same deterministic artifact directory
    /// name the migrate pass writes, so a shard on a different machine finds it
    /// from the app id alone.
    @Fact
    func ArtifactDirectoryNameIsDeterministicPerLayout() {
        let repository = MigrationPipeline.ArtifactDirectoryName(
            "src/Core/Core.csproj",
            MigrationOutputLayout.Repository
        )
        Assert.Equal(
            repository,
            MigrationPipeline.ArtifactDirectoryName("src/Core/Core.csproj", MigrationOutputLayout.Repository)
        )
        Assert.StartsWith("src_Core_Core.csproj-", repository, StringComparison.Ordinal)
        // Two apps whose sanitized ids collide must not share a directory.
        Assert.NotEqual(
            repository,
            MigrationPipeline.ArtifactDirectoryName("src/Core/Core.csproj ", MigrationOutputLayout.Repository)
        )
        Assert.Equal(
            "corpus_L1-Console",
            MigrationPipeline.ArtifactDirectoryName("corpus/L1-Console", MigrationOutputLayout.DiagnosticRun)
        )
    }

    /// A shard runs stages 2–4 only. Translate is absent by CONSTRUCTION, not
    /// by a runtime skip, so a shard can never re-translate a subset of the
    /// repository behind the linked-source cross-check's back.
    @Fact
    func ValidationStagesExcludeTranslate() {
        let kinds = ValidateCommand.ValidationStages().Select((s IMigrationStage) -> s.Kind).ToArray()
        Assert.Equal(
            []MigrationStageKind{
                MigrationStageKind.Compile,
                MigrationStageKind.IlVerify,
                MigrationStageKind.TestParity
            },
            kinds
        )
        Assert.DoesNotContain(MigrationStageKind.Translate, kinds)
    }

    /// `--shard i/N` partitions the discovered app set: every app lands in
    /// exactly one shard, and the union is the whole set.
    @Fact
    func ShardSelectionPartitionsTheAppSet() {
        let apps IReadOnlyList[CorpusApp] = Enumerable
            .Range(0, 11)
            .Select((i int32) -> CorpusApp("src/P$i/P$i.csproj", "/repo/src/P$i/P$i.csproj", TargetKind.Library))
            .ToList()
        let seen = List[string]()
        for var shard = 1; shard <= 4; shard++ {
            let selected = ValidateCommand.SelectApps(apps, Array.Empty[string](), shard, 4, out var error)
            Assert.Null(error)
            seen.AddRange(selected.Select((a CorpusApp) -> a.Id))
        }
        Assert.Equal(
            apps.Select((a CorpusApp) -> a.Id).OrderBy((id string) -> id, StringComparer.Ordinal),
            seen.OrderBy((id string) -> id, StringComparer.Ordinal)
        )
        Assert.Equal(seen.Count, seen.Distinct(StringComparer.Ordinal).Count())
    }

    /// An `--app` id outside the discovered (post-exclude) set is a hard
    /// error, not a silently empty shard: an app quietly dropped would shrink
    /// the gate's denominator and hide a regression.
    @Fact
    func UnknownAppIsRejected() {
        let apps IReadOnlyList[CorpusApp] = []CorpusApp{
            CorpusApp("src/A/A.csproj", "/repo/src/A/A.csproj", TargetKind.Library)
        }
        ValidateCommand.SelectApps(apps, []string{"src/B/B.csproj"}, -1, 0, out var error)
        Assert.Contains("not in the discovered", error, StringComparison.Ordinal)
        ValidateCommand.SelectApps(apps, []string{"src/A/A.csproj"}, 1, 2, out var conflict)
        Assert.Contains("mutually exclusive", conflict, StringComparison.Ordinal)
    }

    /// Shard specifications are validated, not silently coerced.
    /// @param value The raw `--shard` value.
    /// @param expected Whether it should parse.
    @Theory
    @InlineData("1/6", true)
    @InlineData("6/6", true)
    @InlineData("0/6", false)
    @InlineData("7/6", false)
    @InlineData("1/0", false)
    @InlineData("1", false)
    @InlineData("a/b", false)
    func ShardSpecificationIsValidated(value string, expected bool) {
        Assert.Equal(expected, ValidateCommand.TryParseShard(value, out _, out _))
    }

    /// The merge reconstructs a whole run: translate from the migrate pass,
    /// stages 2–4 from the owning shard, a translate-failed app keeping the
    /// whole run's short-circuit shape, and the green count matching.
    @Fact
    func MergeReconstructsWholeRunVerdicts() {
        using let temp = Issue3668ShardedValidationTests.TempDirectory()
        let migratePath = Path.Combine(temp.Path, "migrate.json")
        let shardPath = Path.Combine(temp.Path, "shard.json")
        let outPath = Path.Combine(temp.Path, "merged.json")
        File.WriteAllText(migratePath, `{
  "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
  "succeeded": false,
  "apps": [
    { "appId": "src/Green/Green.csproj", "succeeded": true,
      "stages": [ { "stage": "translate", "status": "passed", "artifactCount": 0 } ],
      "artifacts": [], "fingerprints": [] },
    { "appId": "src/Red/Red.csproj", "succeeded": true,
      "stages": [ { "stage": "translate", "status": "passed", "artifactCount": 0 } ],
      "artifacts": [], "fingerprints": [] },
    { "appId": "src/NoTranslate/NoTranslate.csproj", "succeeded": false,
      "failureCategory": "translation-unsupported",
      "stages": [ { "stage": "translate", "status": "failed", "artifactCount": 1 } ],
      "artifacts": [ "a/translate-1.json" ], "fingerprints": [ "sha256:aa" ] }
  ]
}`)
        File.WriteAllText(shardPath, `{
  "runId": "r2", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
  "succeeded": false,
  "apps": [
    { "appId": "src/Green/Green.csproj", "succeeded": true,
      "stages": [
        { "stage": "compile", "status": "passed", "artifactCount": 0 },
        { "stage": "ilverify", "status": "passed", "artifactCount": 0 },
        { "stage": "test-parity", "status": "passed", "artifactCount": 0 } ],
      "artifacts": [], "fingerprints": [] },
    { "appId": "src/Red/Red.csproj", "succeeded": false,
      "failureCategory": "compile-error",
      "stages": [
        { "stage": "compile", "status": "failed", "artifactCount": 2 },
        { "stage": "ilverify", "status": "skipped", "artifactCount": 0 },
        { "stage": "test-parity", "status": "skipped", "artifactCount": 0 } ],
      "artifacts": [ "b/compile-2.json" ], "fingerprints": [ "sha256:bb" ] }
  ]
}`)
        RunMerge(migratePath, outPath, shardPath)
        using let merged = JsonDocument.Parse(File.ReadAllText(outPath))
        let apps = merged.RootElement.GetProperty("apps")
        Assert.Equal(3, apps.GetArrayLength())
        let green = apps[0]
        Assert.True(green.GetProperty("succeeded").GetBoolean())
        Assert.False(green.GetProperty("unverified").GetBoolean())
        Assert.Equal(
            []string{"translate", "compile", "ilverify", "test-parity"},
            green
                .GetProperty("stages")
                .EnumerateArray()
                .Select((s JsonElement) -> s.GetProperty("stage").GetString()!!)
                .ToArray()
        )
        let red = apps[1]
        Assert.False(red.GetProperty("succeeded").GetBoolean())
        Assert.Equal("compile-error", red.GetProperty("failureCategory").GetString())
        Assert.Equal(
            "b/compile-2.json",
            Assert.Single(red.GetProperty("artifacts").EnumerateArray().Select((a JsonElement) -> a.GetString()!!))
        )
        // A translate failure never reaches a shard, but keeps the whole run's
        // four-stage shape with the later stages skipped.
        let untranslated = apps[2]
        Assert.False(untranslated.GetProperty("succeeded").GetBoolean())
        Assert.Equal(
            []string{"passed_or_failed", "skipped", "skipped", "skipped"},
            untranslated
                .GetProperty("stages")
                .EnumerateArray()
                .Select(
                (s JsonElement, index int32) -> if index == 0 {
                    "passed_or_failed"
                } else {
                    s.GetProperty("status").GetString()!!
                }
            )
                .ToArray()
        )
        Assert.False(merged.RootElement.GetProperty("succeeded").GetBoolean())
        Assert.Equal(1, apps.EnumerateArray().Count((a JsonElement) -> a.GetProperty("succeeded").GetBoolean()))
    }

    /// An app that translated but that no shard reported on fails the merge.
    /// Silently treating it as absent would shrink the denominator; silently
    /// treating it as green would inflate the floor. Both hide regressions —
    /// which is precisely the failure mode issue #3668 exists to end.
    @Fact
    func MergeFailsWhenATranslatedAppHasNoShardResult() {
        using let temp = Issue3668ShardedValidationTests.TempDirectory()
        let migratePath = Path.Combine(temp.Path, "migrate.json")
        let shardPath = Path.Combine(temp.Path, "shard.json")
        let outPath = Path.Combine(temp.Path, "merged.json")
        File.WriteAllText(migratePath, `{
  "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p", "succeeded": true,
  "apps": [
    { "appId": "src/Orphan/Orphan.csproj", "succeeded": true,
      "stages": [ { "stage": "translate", "status": "passed", "artifactCount": 0 } ],
      "artifacts": [], "fingerprints": [] }
  ]
}`)
        File.WriteAllText(
            shardPath,
            "{ \"runId\": \"r2\", \"timestamp\": \"t\", \"gscVersion\": \"v\", \"gscPath\": \"p\",\n  \"succeeded\": true, \"apps\": [] }"
        )
        let (exit, output) = TryRunMerge(migratePath, outPath, shardPath)
        Assert.NotEqual(0, exit)
        Assert.Contains("no shard reported a result", output, StringComparison.Ordinal)
    }

    private class TempDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(Path.GetTempPath(), "cs2gs-3668-" + Guid.NewGuid().ToString("n"))
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(this.Path, recursive: true)
            } catch (IOException) {
                // Best-effort cleanup.

            }
        }
    }

    shared {
        private func RunMerge(migratePath string, outPath string, shardPaths ...string) {
            let (exit, output) = TryRunMerge(migratePath, outPath, shardPaths)
            Assert.True(exit == 0, "merge-selfmig-runs.py failed: " + output)
        }

        private func TryRunMerge(migratePath string, outPath string, shardPaths ...string)(Exit int32, Output string) {
            let script = Path.Combine(RepoRoot(), "build", "merge-selfmig-runs.py")
            let startInfo = ProcessStartInfo("python3"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add(script)
            startInfo.ArgumentList.Add("--migrate")
            startInfo.ArgumentList.Add(migratePath)
            startInfo.ArgumentList.Add("--out")
            startInfo.ArgumentList.Add(outPath)
            for shardPath in shardPaths {
                startInfo.ArgumentList.Add(shardPath)
            }
            using let process Process? = Process.Start(startInfo)
            let output = process!!.StandardOutput.ReadToEnd() + process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            return (process!!.ExitCode, output)
        }

        private func RepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil && !Directory.Exists(Path.Combine(dir.FullName, "build")) {
                dir = dir.Parent
            }
            Assert.NotNull(dir)
            return dir!!.FullName
        }

        private func NullGsc() GscInvoker -> GscInvoker("/nonexistent/gsc.dll")
    }
}
