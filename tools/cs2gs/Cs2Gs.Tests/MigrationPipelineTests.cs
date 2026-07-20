// <copyright file="MigrationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for the stage-1/stage-2 migration pipeline (ADR-0115 §C/§D): the
/// fingerprint/dedup contract (§D.2), the triage artifact schema (§D.1), the L1
/// happy path through stage 2, captured failures, and <c>retryHistory</c>.
/// </summary>
public class MigrationPipelineTests
{
    /// <summary>
    /// The dedup fingerprint (§D.2) is identical for the same
    /// category/stage/diagnostic/construct-skeleton even when identifiers,
    /// literals, and positions differ, and differs when the diagnostic id
    /// changes — and is always rendered with the <c>sha256:</c> prefix.
    /// </summary>
    [Fact]
    public void Fingerprint_DedupsAcrossNamesAndPositions_ButSplitsOnDiagnosticId()
    {
        string a = Fingerprint.Compute(
            "compile-error", "compile", "GS0100", "GSharpConstruct", "let total int32 = sum(items, 3)");
        string b = Fingerprint.Compute(
            "compile-error", "compile", "GS0100", "GSharpConstruct", "let amount int32 = add(values, 42)");

        Assert.Equal(a, b);
        Assert.StartsWith("sha256:", a, StringComparison.Ordinal);

        string differentId = Fingerprint.Compute(
            "compile-error", "compile", "GS0313", "GSharpConstruct", "let total int32 = sum(items, 3)");
        Assert.NotEqual(a, differentId);

        string differentKind = Fingerprint.Compute(
            "compile-error", "compile", "GS0100", "FuncConstruct", "let total int32 = sum(items, 3)");
        Assert.NotEqual(a, differentKind);
    }

    /// <summary>
    /// The normalizer reduces a snippet to its identifier/literal-erased
    /// skeleton, preserving punctuation structure.
    /// </summary>
    [Fact]
    public void NormalizeShape_StripsIdentifiersAndLiterals_ToSkeleton()
    {
        string shape = Fingerprint.NormalizeShape("foo.Bar(\"hi\", 42, baz)");
        Assert.Equal("id.id(lit, lit, id)", shape);
        Assert.Equal(shape, Fingerprint.NormalizeShape("qux.Zap('x', 7, other)"));
    }

    /// <summary>
    /// A stage-2 <c>compile-error</c> artifact carries every §D.1 field, the
    /// <c>sha256:</c> fingerprint, and labels <c>Oats</c> + <c>bug</c>.
    /// </summary>
    [Fact]
    public void CompileErrorArtifact_HasFullSchema_AndBugLabel()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        var emitted = new EmittedGsFile(
            "/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", "func F() {\n    let x = g(1)\n}\n");
        var diagnostic = new GscDiagnostic(
            "GS0100", "no overload for 'g'", "error", "Sample.gs", 2, 13);

        TriageArtifact artifact = builder.CompileError(diagnostic, emitted);
        string json = JsonSerializer.Serialize(artifact, TriageSerialization.Options);
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;

        foreach (string field in new[]
        {
            "schemaVersion", "runId", "timestamp", "gscVersion", "corpusAppId", "stage", "category",
            "diagnostic", "sourceLocation", "offendingCSharpConstruct", "suggestedIssue", "fingerprint",
            "retryHistory",
        })
        {
            Assert.True(root.TryGetProperty(field, out _), $"missing field '{field}'");
        }

        Assert.Equal("1.0", root.GetProperty("schemaVersion").GetString());
        Assert.Equal("compile", root.GetProperty("stage").GetString());
        Assert.Equal("compile-error", root.GetProperty("category").GetString());
        Assert.Equal("GS0100", root.GetProperty("diagnostic").GetProperty("id").GetString());
        Assert.Equal(2, root.GetProperty("sourceLocation").GetProperty("gsLine").GetInt32());
        Assert.True(root.GetProperty("sourceLocation").GetProperty("csFile").ValueKind == JsonValueKind.Null);
        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal);

        string[] labels = root.GetProperty("suggestedIssue").GetProperty("labels")
            .EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Contains("Oats", labels);
        Assert.Contains("bug", labels);
    }

    /// <summary>
    /// A stage-1 <c>translation-unsupported</c> artifact labels with <c>Oats</c>
    /// only (no <c>bug</c>) and maps the C# location, leaving the G# side null.
    /// </summary>
    [Fact]
    public void TranslationUnsupportedArtifact_HasOatsOnly_AndNullGsLocation()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        var diagnostic = new TranslationDiagnostic(
            "CastExpression", "casts have no canonical G# form yet", null, TranslationSeverity.Unsupported);

        TriageArtifact artifact = builder.TranslationUnsupported(diagnostic);

        Assert.Equal("translation-unsupported", artifact.Category);
        Assert.Equal("translate", artifact.Stage);
        Assert.False(string.IsNullOrEmpty(artifact.Diagnostic.Id));
        Assert.Null(artifact.SourceLocation.GsFile);
        Assert.Null(artifact.SourceLocation.GsLine);
        Assert.Contains("Oats", artifact.SuggestedIssue.Labels);
        Assert.DoesNotContain("bug", artifact.SuggestedIssue.Labels);
        Assert.StartsWith("sha256:", artifact.Fingerprint, StringComparison.Ordinal);
    }

    /// <summary>
    /// Running the pipeline over <c>corpus/L1-Console</c> yields stage 1 and
    /// stage 2 GREEN with zero artifacts. Gated on the compiler artifact being
    /// present (it is when <c>GSharp.sln</c> is built), like the e2e test.
    /// </summary>
    [Fact]
    public async Task L1_StagesOneAndTwo_AreGreen_WithZeroArtifacts()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l1-green");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };

        // Pin to stages 1–2 so this test stays focused on the compile gate
        // regardless of the default stage list (which now also runs ilverify).
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(l1);

        RunResult result = await pipeline.RunAsync(new[] { l1 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(app.Succeeded, "L1 must migrate green through stage 2.");
        Assert.Empty(app.Artifacts);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
        Assert.Equal(2, app.Stages.Count);
    }

    /// <summary>
    /// Issue #973 regression guard: pointing the pipeline at
    /// <c>corpus/L2-Library</c> (a <c>class Rectangle</c> holding a
    /// <c>Dimensions</c> value-type field) now migrates GREEN through the
    /// compile stage. This previously failed with the emit ICE
    /// <c>GS9998: Struct 'S' has no emitted TypeDef.</c> Gated on compiler
    /// presence (the pipeline resolves <c>gsc</c> up front).
    /// </summary>
    [Fact]
    public async Task L2_StagesOneAndTwo_AreGreen_WithZeroArtifacts()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l2-green");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };

        // Pin to stages 1–2 so this test stays focused on the compile gate
        // regardless of the default stage list (which also runs ilverify).
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        CorpusApp l2 = CorpusDiscovery.FindById(corpus, "corpus/L2-Library");
        Assert.NotNull(l2);

        RunResult result = await pipeline.RunAsync(new[] { l2 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(app.Succeeded, "L2 must migrate green through stage 2 (issue #973).");
        Assert.Empty(app.Artifacts);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
        Assert.Equal(2, app.Stages.Count);
    }

    /// <summary>
    /// MSBuild-generated friend-assembly metadata must become the equivalent
    /// G# assembly annotation so migrated test projects can access internals.
    /// </summary>
    [Fact]
    public async Task L2_Translate_PreservesInternalsVisibleTo()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l2-friend-assembly");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });

        CorpusApp l2 = CorpusDiscovery.FindById(corpus, "corpus/L2-Library");
        RunResult result = await pipeline.RunAsync(new[] { l2 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(app.Succeeded);
        string assemblyInfo = Directory.GetFiles(
            Path.Combine(outRoot, result.RunId, MigrationPipeline.SanitizeAppId(l2.Id)),
            "AssemblyInfo.gs",
            SearchOption.AllDirectories).Single();
        Assert.Equal(
            "@assembly:InternalsVisibleTo(\"L2-Library.Tests\")" + Environment.NewLine,
            File.ReadAllText(assemblyInfo));
    }

    /// <summary>
    /// Pointing the pipeline at <c>corpus/CompileGap-Library</c> translates
    /// cleanly but reaches the compile stage and captures a
    /// <c>compile-error</c> triage artifact. That fixture exists solely to
    /// exercise this machinery: its body translates to valid G# yet references
    /// an undefined helper, so <c>gsc</c> rejects it with a stable diagnostic
    /// regardless of which real compiler gaps are open or closed (the earlier
    /// anchor, <c>corpus/L3-Library</c>, now compiles green). The artifact
    /// carries a non-empty diagnostic id and a stable <c>sha256:</c>
    /// fingerprint. Gated on compiler presence (the pipeline resolves
    /// <c>gsc</c> up front).
    /// </summary>
    [Fact]
    public async Task CompileStageFailure_WritesTriageArtifact()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("compilegap-capture");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp l3 = CorpusDiscovery.FindById(corpus, "corpus/CompileGap-Library");
        RunResult result = await pipeline.RunAsync(new[] { l3 });
        AppResult app = Assert.Single(result.Apps);

        Assert.False(app.Succeeded);
        Assert.Equal("compile-error", app.FailureCategory);
        Assert.NotEmpty(app.Artifacts);

        string artifactPath = Path.Combine(outRoot, result.RunId, app.Artifacts[0]);
        Assert.True(File.Exists(artifactPath), "the triage artifact file must be written: " + artifactPath);

        TriageArtifact artifact = JsonSerializer.Deserialize<TriageArtifact>(
            File.ReadAllText(artifactPath), TriageSerialization.Options);
        Assert.Equal("compile-error", artifact.Category);
        Assert.False(string.IsNullOrEmpty(artifact.Diagnostic.Id));
        Assert.StartsWith("sha256:", artifact.Fingerprint, StringComparison.Ordinal);
    }

    /// <summary>
    /// Re-running against the same <c>--gsc</c> carries the prior run forward in
    /// each fingerprint's <c>retryHistory</c> (the §C retry mechanism). Anchored
    /// on <c>corpus/CompileGap-Library</c>, whose synthetic body always fails at
    /// the compile stage (an undefined-helper reference), so the machinery is
    /// exercised independent of the corpus's evolving compile health.
    /// Gated on compiler presence.
    /// </summary>
    [Fact]
    public async Task RetryHistory_AccumulatesAcrossRuns_ForSameFingerprint()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("retry");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };

        CorpusApp l3 = CorpusDiscovery.FindById(corpus, "corpus/CompileGap-Library");

        RunResult first = await new MigrationPipeline(options).RunAsync(new[] { l3 });
        RunResult second = await new MigrationPipeline(options).RunAsync(new[] { l3 });

        Assert.NotEqual(first.RunId, second.RunId);

        string secondArtifact = Path.Combine(outRoot, second.RunId, second.Apps[0].Artifacts[0]);
        TriageArtifact artifact = JsonSerializer.Deserialize<TriageArtifact>(
            File.ReadAllText(secondArtifact), TriageSerialization.Options);

        Assert.NotEmpty(artifact.RetryHistory);
        Assert.Contains(artifact.RetryHistory, e => e.RunId == first.RunId);
        Assert.All(artifact.RetryHistory, e => Assert.Equal("fail", e.Result));
    }

    /// <summary>
    /// Issue #1751 regression guard: a prior run directory that also contains a
    /// stage-4 (test-parity) NuGet-restore scaffold under
    /// <c>&lt;appDir&gt;/test-parity/&lt;Lib&gt;/obj/</c> (e.g.
    /// <c>project.assets.json</c>, <c>*.nuget.dgspec.json</c>) must not have
    /// those decoy JSON files opened at all — <see cref="LoadPriorRetryEntries"/>
    /// (reached via reflection since it is a pipeline-internal helper) is
    /// scoped to exactly the writer's layout, <c>&lt;runDir&gt;/&lt;appDir&gt;/*.json</c>
    /// (top-level only), so it never descends into <c>obj/</c>. The decoy
    /// files are chmod'd unreadable as a canary: were they opened, the
    /// unhandled <see cref="UnauthorizedAccessException"/> would fail this
    /// test loudly (only <see cref="JsonException"/>/<see cref="IOException"/>
    /// are swallowed by <c>TryReadArtifact</c>). Skipped on Windows, which has
    /// no POSIX permission bits to enforce the canary.
    /// </summary>
    [Fact]
    public void LoadPriorRetryEntries_IgnoresObjArtifacts_AndDoesNotDescendIntoThem()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        string outputRoot = NewOutputRoot("retry-scan-scope");
        string priorRunDir = Path.Combine(outputRoot, "2026-01-01T00-00-00Z_aaaaaa");
        string appDir = Path.Combine(priorRunDir, "corpus_Sample");
        Directory.CreateDirectory(appDir);

        // The real retry-entry artifact: written by WriteArtifacts() directly
        // under the app's run directory as "<stage>-<12hex fingerprint>.json".
        var builder = new TriageBuilder(
            "2026-01-01T00-00-00Z_aaaaaa", "2026-01-01T00:00:00Z", "0.2.0+abc", "corpus/Sample");
        var diagnostic = new GscDiagnostic("GS0100", "no overload for 'g'", "error", "Sample.gs", 2, 13);
        TriageArtifact real = builder.CompileError(diagnostic, null);
        string realFile = Path.Combine(appDir, "compile-" + FingerprintShort(real.Fingerprint) + ".json");
        File.WriteAllText(realFile, JsonSerializer.Serialize(real, TriageSerialization.Options));

        // Decoy stage-4 NuGet/MSBuild artifacts nested under obj/, exactly the
        // layout GsharpTestProjectRunner.Run() scaffolds
        // (<appDir>/test-parity/<Lib>/obj/*.json). Made unreadable so any
        // attempt to open them throws instead of silently succeeding.
        string objDir = Path.Combine(appDir, "test-parity", "Sample", "obj");
        Directory.CreateDirectory(objDir);
        string[] decoys =
        {
            Path.Combine(objDir, "project.assets.json"),
            Path.Combine(objDir, "Sample.csproj.nuget.dgspec.json"),
            Path.Combine(objDir, "Sample.csproj.nuget.g.props.json"),
        };
        foreach (string decoy in decoys)
        {
            File.WriteAllText(decoy, new string('x', 1024)); // not even valid JSON
            File.SetUnixFileMode(decoy, UnixFileMode.None); // canary: reading this throws
        }

        try
        {
            MethodInfo method = typeof(MigrationPipeline).GetMethod(
                "LoadPriorRetryEntries", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(method);

            var result = (System.Collections.Generic.IReadOnlyDictionary<string, System.Collections.Generic.List<TriageRetryEntry>>)
                method.Invoke(null, new object[] { outputRoot, "2026-01-02T00-00-00Z_bbbbbb" });

            TriageRetryEntry entry = Assert.Single(Assert.Single(result).Value);
            Assert.Equal("2026-01-01T00-00-00Z_aaaaaa", entry.RunId);
            Assert.Single(result); // exactly the one real fingerprint, nothing from the decoys
        }
        finally
        {
            // Restore permissions so test cleanup (temp-dir deletion) can proceed.
            foreach (string decoy in decoys)
            {
                File.SetUnixFileMode(decoy, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
    }

    /// <summary>
    /// A stage-2 skip (e.g. a genuinely-unavailable dependency) with no
    /// failing stage rolls up to an app that is <see cref="AppResult.Unverified"/>
    /// but still <see cref="AppResult.Succeeded"/>, and a run that is
    /// <see cref="RunResult.Unverified"/> but still <see cref="RunResult.Succeeded"/>
    /// — never "green" but also never exiting non-zero (issue #1831).
    /// </summary>
    [Fact]
    public async Task SkippedStage_NoFailure_RollsUpToUnverified_NotGreen_AppAndRun()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("skip-rollup");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new PassStage(MigrationStageKind.Translate), new SkipStage(MigrationStageKind.Compile) });

        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(l1);

        RunResult result = await pipeline.RunAsync(new[] { l1 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(app.Succeeded);
        Assert.True(app.Unverified);
        Assert.True(result.Succeeded);
        Assert.True(result.Unverified);
    }

    /// <summary>
    /// A failed stage takes precedence over a later skip in the same app: the
    /// app and run are "Failed" (<see cref="AppResult.Succeeded"/> /
    /// <see cref="RunResult.Succeeded"/> both <see langword="false"/>), never
    /// "Unverified" — the general rollup precedence is Failed &gt; Skipped &gt;
    /// Green (issue #1831).
    /// </summary>
    [Fact]
    public async Task FailedStage_TakesPrecedenceOverSkip_AppAndRunAreFailed_NotUnverified()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("fail-precedence");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new FailStage(MigrationStageKind.Translate) });

        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(l1);

        RunResult result = await pipeline.RunAsync(new[] { l1 });
        AppResult app = Assert.Single(result.Apps);

        Assert.False(app.Succeeded);
        Assert.False(app.Unverified);
        Assert.False(result.Succeeded);
        Assert.False(result.Unverified);
    }

    /// <summary>A fixed-outcome stage double, used to drive pipeline rollup tests deterministically.</summary>
    private sealed class PassStage : IMigrationStage
    {
        public PassStage(MigrationStageKind kind) => this.Kind = kind;

        public MigrationStageKind Kind { get; }

        public Task<StageOutcome> ExecuteAsync(StageExecutionContext context, CancellationToken cancellationToken = default) =>
            Task.FromResult(StageOutcome.Passed());
    }

    /// <summary>A fixed-outcome stage double that reports <see cref="StageStatus.Skipped"/>.</summary>
    private sealed class SkipStage : IMigrationStage
    {
        public SkipStage(MigrationStageKind kind) => this.Kind = kind;

        public MigrationStageKind Kind { get; }

        public Task<StageOutcome> ExecuteAsync(StageExecutionContext context, CancellationToken cancellationToken = default) =>
            Task.FromResult(StageOutcome.Skipped());
    }

    /// <summary>A fixed-outcome stage double that reports <see cref="StageStatus.Failed"/>.</summary>
    private sealed class FailStage : IMigrationStage
    {
        public FailStage(MigrationStageKind kind) => this.Kind = kind;

        public MigrationStageKind Kind { get; }

        public Task<StageOutcome> ExecuteAsync(StageExecutionContext context, CancellationToken cancellationToken = default) =>
            Task.FromResult(StageOutcome.Failed(Array.Empty<TriageArtifact>()));
    }

    private static string FingerprintShort(string fingerprint)
    {
        string hex = fingerprint.StartsWith("sha256:", StringComparison.Ordinal)
            ? fingerprint.Substring("sha256:".Length)
            : fingerprint;
        return hex.Length <= 12 ? hex : hex.Substring(0, 12);
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
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

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate tools/cs2gs/corpus above " + AppContext.BaseDirectory);
    }
}
