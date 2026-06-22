// <copyright file="MigrationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
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
        var pipeline = new MigrationPipeline(options);

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
    /// Pointing the pipeline at <c>corpus/L2-Library</c> (whose advanced
    /// constructs are not all mapped) captures a stage-1
    /// <c>translation-unsupported</c> artifact on disk with a non-empty
    /// diagnostic id and a stable <c>sha256:</c> fingerprint. Gated on compiler
    /// presence (the pipeline resolves <c>gsc</c> up front).
    /// </summary>
    [Fact]
    public async Task L2_StageOneFailure_WritesTriageArtifact()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l2-capture");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp l2 = CorpusDiscovery.FindById(corpus, "corpus/L2-Library");
        RunResult result = await pipeline.RunAsync(new[] { l2 });
        AppResult app = Assert.Single(result.Apps);

        Assert.False(app.Succeeded);
        Assert.Equal("translation-unsupported", app.FailureCategory);
        Assert.NotEmpty(app.Artifacts);

        string artifactPath = Path.Combine(outRoot, result.RunId, app.Artifacts[0]);
        Assert.True(File.Exists(artifactPath), "the triage artifact file must be written: " + artifactPath);

        TriageArtifact artifact = JsonSerializer.Deserialize<TriageArtifact>(
            File.ReadAllText(artifactPath), TriageSerialization.Options);
        Assert.Equal("translation-unsupported", artifact.Category);
        Assert.False(string.IsNullOrEmpty(artifact.Diagnostic.Id));
        Assert.StartsWith("sha256:", artifact.Fingerprint, StringComparison.Ordinal);
    }

    /// <summary>
    /// Re-running against the same <c>--gsc</c> carries the prior run forward in
    /// each fingerprint's <c>retryHistory</c> (the §C retry mechanism). Gated on
    /// compiler presence.
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

        CorpusApp l2 = CorpusDiscovery.FindById(corpus, "corpus/L2-Library");

        RunResult first = await new MigrationPipeline(options).RunAsync(new[] { l2 });
        RunResult second = await new MigrationPipeline(options).RunAsync(new[] { l2 });

        Assert.NotEqual(first.RunId, second.RunId);

        string secondArtifact = Path.Combine(outRoot, second.RunId, second.Apps[0].Artifacts[0]);
        TriageArtifact artifact = JsonSerializer.Deserialize<TriageArtifact>(
            File.ReadAllText(secondArtifact), TriageSerialization.Options);

        Assert.NotEmpty(artifact.RetryHistory);
        Assert.Contains(artifact.RetryHistory, e => e.RunId == first.RunId);
        Assert.All(artifact.RetryHistory, e => Assert.Equal("fail", e.Result));
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
