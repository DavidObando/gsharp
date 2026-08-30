// <copyright file="Issue3668ShardedValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using Cs2Gs.Cli;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3668: the self-migration gate now runs as ONE whole-repository
/// translate pass plus N independent validation shards. These tests pin the
/// three pieces that make that split safe:
/// <list type="bullet">
/// <item><description>
/// the <see cref="ValidationManifest"/> hand-off carries exactly the
/// translate-derived state stages 2–4 consume, and rehydrates it from a
/// migrated tree;
/// </description></item>
/// <item><description>
/// shard selection narrows what is EXECUTED, never what is discovered
/// (<c>--exclude</c> must stay identical across jobs, or reference resolution
/// breaks and phantom cascades appear);
/// </description></item>
/// <item><description>
/// the merge reconstructs the same per-app verdicts a single whole run would
/// have produced, and refuses to silently drop an app.
/// </description></item>
/// </list>
/// </summary>
public class Issue3668ShardedValidationTests
{
    /// <summary>
    /// The manifest round-trips the translate-derived state and rehydrates the
    /// emitted G# set by re-reading the migrated tree — so a shard sees the
    /// same <c>EmittedFiles</c> the whole run's compile stage would.
    /// </summary>
    [Fact]
    public void ManifestRoundTripsTranslateDerivedState()
    {
        using var temp = new TempDirectory();
        string migrated = Path.Combine(temp.Path, "migrated");
        string projectDir = Path.Combine(migrated, "src", "Lib");
        Directory.CreateDirectory(projectDir);
        string gsPath = Path.Combine(projectDir, "Widget.gs");
        File.WriteAllText(gsPath, "package Lib\n");

        string reference = Path.Combine(temp.Path, "Some.Package.dll");
        File.WriteAllText(reference, string.Empty);

        var app = new CorpusApp("src/Lib/Lib.csproj", Path.Combine(temp.Path, "Lib.csproj"), TargetKind.Library);
        var options = new PipelineOptions { OutputLayout = MigrationOutputLayout.Repository };
        var context = new StageExecutionContext(
            app,
            options,
            NullGsc(),
            projectDir,
            Path.Combine(temp.Path, "artifacts"),
            new TriageBuilder("run", "ts", "gsc", app.Id));
        context.IsTestProject = true;
        context.IsAnalyzerProject = true;
        context.RootNamespace = "Lib";
        context.AssemblyName = "Lib";
        context.GeneratedFriendAssemblies.Add("Lib.Tests");
        context.ExternalReferencePaths.Add(reference);
        context.ExternalReferencePaths.Add(Path.Combine(temp.Path, "Absent.dll"));
        context.EmittedFiles.Add(new EmittedGsFile(gsPath, "src_Lib/Widget.gs", "Widget.cs", "package Lib\n"));

        string artifactDir = Path.Combine(temp.Path, "artifacts");
        ValidationManifest.Write(ValidationManifest.Capture(context, translated: true, migrated), artifactDir);

        ValidationManifest read = ValidationManifest.Read(artifactDir);
        Assert.NotNull(read);
        Assert.True(read.Translated);
        Assert.Equal("src/Lib/Lib.csproj", read.AppId);

        // Emitted paths are stored relative to the migrated tree so the tree
        // can be re-rooted onto a shard runner.
        Assert.Equal("src/Lib/Widget.gs", Assert.Single(read.EmittedFiles).Path);

        var rehydrated = new StageExecutionContext(
            app,
            new PipelineOptions { OutputLayout = MigrationOutputLayout.Repository },
            NullGsc(),
            projectDir,
            artifactDir,
            new TriageBuilder("run2", "ts", "gsc", app.Id));
        read.Hydrate(rehydrated, migrated);

        Assert.True(rehydrated.IsTestProject);
        Assert.True(rehydrated.IsAnalyzerProject);
        Assert.Equal("Lib", rehydrated.RootNamespace);
        Assert.Equal("Lib", rehydrated.AssemblyName);
        Assert.Equal(new[] { "Lib.Tests" }, rehydrated.GeneratedFriendAssemblies.ToArray());

        // A package path the shard cannot see is dropped rather than handed to
        // ilverify as a dangling -r; ilverify scans the output directory anyway.
        Assert.Equal(new[] { reference }, rehydrated.ExternalReferencePaths.ToArray());

        EmittedGsFile emitted = Assert.Single(rehydrated.EmittedFiles);
        Assert.Equal(Path.GetFullPath(gsPath), Path.GetFullPath(emitted.GsPath));
        Assert.Equal("src_Lib/Widget.gs", emitted.RelativeGsPath);
        Assert.Equal("package Lib\n", emitted.GSharpSource);
    }

    /// <summary>
    /// The manifest is looked up by the same deterministic artifact directory
    /// name the migrate pass writes, so a shard on a different machine finds it
    /// from the app id alone.
    /// </summary>
    [Fact]
    public void ArtifactDirectoryNameIsDeterministicPerLayout()
    {
        string repository = MigrationPipeline.ArtifactDirectoryName(
            "src/Core/Core.csproj", MigrationOutputLayout.Repository);
        Assert.Equal(repository, MigrationPipeline.ArtifactDirectoryName(
            "src/Core/Core.csproj", MigrationOutputLayout.Repository));
        Assert.StartsWith("src_Core_Core.csproj-", repository, StringComparison.Ordinal);

        // Two apps whose sanitized ids collide must not share a directory.
        Assert.NotEqual(
            repository,
            MigrationPipeline.ArtifactDirectoryName("src/Core/Core.csproj ", MigrationOutputLayout.Repository));

        Assert.Equal(
            "corpus_L1-Console",
            MigrationPipeline.ArtifactDirectoryName("corpus/L1-Console", MigrationOutputLayout.DiagnosticRun));
    }

    /// <summary>
    /// A shard runs stages 2–4 only. Translate is absent by CONSTRUCTION, not
    /// by a runtime skip, so a shard can never re-translate a subset of the
    /// repository behind the linked-source cross-check's back.
    /// </summary>
    [Fact]
    public void ValidationStagesExcludeTranslate()
    {
        MigrationStageKind[] kinds = ValidateCommand.ValidationStages().Select(s => s.Kind).ToArray();
        Assert.Equal(
            new[] { MigrationStageKind.Compile, MigrationStageKind.IlVerify, MigrationStageKind.TestParity },
            kinds);
        Assert.DoesNotContain(MigrationStageKind.Translate, kinds);
    }

    /// <summary>
    /// <c>--shard i/N</c> partitions the discovered app set: every app lands in
    /// exactly one shard, and the union is the whole set.
    /// </summary>
    [Fact]
    public void ShardSelectionPartitionsTheAppSet()
    {
        IReadOnlyList<CorpusApp> apps = Enumerable.Range(0, 11)
            .Select(i => new CorpusApp($"src/P{i}/P{i}.csproj", $"/repo/src/P{i}/P{i}.csproj", TargetKind.Library))
            .ToList();

        var seen = new List<string>();
        for (var shard = 1; shard <= 4; shard++)
        {
            IReadOnlyList<CorpusApp> selected = ValidateCommand.SelectApps(
                apps, Array.Empty<string>(), shard, 4, out string error);
            Assert.Null(error);
            seen.AddRange(selected.Select(a => a.Id));
        }

        Assert.Equal(
            apps.Select(a => a.Id).OrderBy(id => id, StringComparer.Ordinal),
            seen.OrderBy(id => id, StringComparer.Ordinal));
        Assert.Equal(seen.Count, seen.Distinct(StringComparer.Ordinal).Count());
    }

    /// <summary>
    /// An <c>--app</c> id outside the discovered (post-exclude) set is a hard
    /// error, not a silently empty shard: an app quietly dropped would shrink
    /// the gate's denominator and hide a regression.
    /// </summary>
    [Fact]
    public void UnknownAppIsRejected()
    {
        IReadOnlyList<CorpusApp> apps = new[]
        {
            new CorpusApp("src/A/A.csproj", "/repo/src/A/A.csproj", TargetKind.Library),
        };

        ValidateCommand.SelectApps(apps, new[] { "src/B/B.csproj" }, -1, 0, out string error);
        Assert.Contains("not in the discovered", error, StringComparison.Ordinal);

        ValidateCommand.SelectApps(apps, new[] { "src/A/A.csproj" }, 1, 2, out string conflict);
        Assert.Contains("mutually exclusive", conflict, StringComparison.Ordinal);
    }

    /// <summary>Shard specifications are validated, not silently coerced.</summary>
    /// <param name="value">The raw <c>--shard</c> value.</param>
    /// <param name="expected">Whether it should parse.</param>
    [Theory]
    [InlineData("1/6", true)]
    [InlineData("6/6", true)]
    [InlineData("0/6", false)]
    [InlineData("7/6", false)]
    [InlineData("1/0", false)]
    [InlineData("1", false)]
    [InlineData("a/b", false)]
    public void ShardSpecificationIsValidated(string value, bool expected)
    {
        Assert.Equal(expected, ValidateCommand.TryParseShard(value, out _, out _));
    }

    /// <summary>
    /// The merge reconstructs a whole run: translate from the migrate pass,
    /// stages 2–4 from the owning shard, a translate-failed app keeping the
    /// whole run's short-circuit shape, and the green count matching.
    /// </summary>
    [Fact]
    public void MergeReconstructsWholeRunVerdicts()
    {
        using var temp = new TempDirectory();
        string migratePath = Path.Combine(temp.Path, "migrate.json");
        string shardPath = Path.Combine(temp.Path, "shard.json");
        string outPath = Path.Combine(temp.Path, "merged.json");

        File.WriteAllText(migratePath, """
        {
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
        }
        """);

        File.WriteAllText(shardPath, """
        {
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
        }
        """);

        RunMerge(migratePath, outPath, shardPath);

        using JsonDocument merged = JsonDocument.Parse(File.ReadAllText(outPath));
        JsonElement apps = merged.RootElement.GetProperty("apps");
        Assert.Equal(3, apps.GetArrayLength());

        JsonElement green = apps[0];
        Assert.True(green.GetProperty("succeeded").GetBoolean());
        Assert.False(green.GetProperty("unverified").GetBoolean());
        Assert.Equal(
            new[] { "translate", "compile", "ilverify", "test-parity" },
            green.GetProperty("stages").EnumerateArray()
                .Select(s => s.GetProperty("stage").GetString()).ToArray());

        JsonElement red = apps[1];
        Assert.False(red.GetProperty("succeeded").GetBoolean());
        Assert.Equal("compile-error", red.GetProperty("failureCategory").GetString());
        Assert.Equal("b/compile-2.json", Assert.Single(
            red.GetProperty("artifacts").EnumerateArray().Select(a => a.GetString())));

        // A translate failure never reaches a shard, but keeps the whole run's
        // four-stage shape with the later stages skipped.
        JsonElement untranslated = apps[2];
        Assert.False(untranslated.GetProperty("succeeded").GetBoolean());
        Assert.Equal(
            new[] { "passed_or_failed", "skipped", "skipped", "skipped" },
            untranslated.GetProperty("stages").EnumerateArray()
                .Select((s, index) => index == 0 ? "passed_or_failed" : s.GetProperty("status").GetString())
                .ToArray());

        Assert.False(merged.RootElement.GetProperty("succeeded").GetBoolean());
        Assert.Equal(1, apps.EnumerateArray().Count(a => a.GetProperty("succeeded").GetBoolean()));
    }

    /// <summary>
    /// An app that translated but that no shard reported on fails the merge.
    /// Silently treating it as absent would shrink the denominator; silently
    /// treating it as green would inflate the floor. Both hide regressions —
    /// which is precisely the failure mode issue #3668 exists to end.
    /// </summary>
    [Fact]
    public void MergeFailsWhenATranslatedAppHasNoShardResult()
    {
        using var temp = new TempDirectory();
        string migratePath = Path.Combine(temp.Path, "migrate.json");
        string shardPath = Path.Combine(temp.Path, "shard.json");
        string outPath = Path.Combine(temp.Path, "merged.json");

        File.WriteAllText(migratePath, """
        {
          "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p", "succeeded": true,
          "apps": [
            { "appId": "src/Orphan/Orphan.csproj", "succeeded": true,
              "stages": [ { "stage": "translate", "status": "passed", "artifactCount": 0 } ],
              "artifacts": [], "fingerprints": [] }
          ]
        }
        """);
        File.WriteAllText(shardPath, """
        { "runId": "r2", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
          "succeeded": true, "apps": [] }
        """);

        (int exit, string output) = TryRunMerge(migratePath, outPath, shardPath);
        Assert.NotEqual(0, exit);
        Assert.Contains("no shard reported a result", output, StringComparison.Ordinal);
    }

    private static void RunMerge(string migratePath, string outPath, params string[] shardPaths)
    {
        (int exit, string output) = TryRunMerge(migratePath, outPath, shardPaths);
        Assert.True(exit == 0, "merge-selfmig-runs.py failed: " + output);
    }

    private static (int Exit, string Output) TryRunMerge(
        string migratePath, string outPath, params string[] shardPaths)
    {
        string script = Path.Combine(RepoRoot(), "build", "merge-selfmig-runs.py");
        var startInfo = new ProcessStartInfo("python3")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("--migrate");
        startInfo.ArgumentList.Add(migratePath);
        startInfo.ArgumentList.Add("--out");
        startInfo.ArgumentList.Add(outPath);
        foreach (string shardPath in shardPaths)
        {
            startInfo.ArgumentList.Add(shardPath);
        }

        using Process process = Process.Start(startInfo);
        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, output);
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "build")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir.FullName;
    }

    private static GscInvoker NullGsc() => new GscInvoker("/nonexistent/gsc.dll");

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            this.Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "cs2gs-3668-" + Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(this.Path, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup.
            }
        }
    }
}
