// <copyright file="ReportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Cs2Gs.Pipeline;
using Cs2Gs.Report;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for the <c>Cs2Gs.Report</c> step (ADR-0115 §F): the
/// <see cref="ReportModel"/> aggregation and fingerprint grouping, the
/// deterministic <c>summary.json</c> schema, and the self-contained,
/// HTML-encoded, deterministic <c>report.html</c>.
/// </summary>
public class ReportTests
{
    /// <summary>
    /// The aggregator collapses the same fingerprint hit by two apps into one
    /// gap with two occurrences, preserves stage order including <c>skipped</c>,
    /// and merges/dedups the retry history (ADR-0115 §F/§D.2).
    /// </summary>
    [Fact]
    public void ReportModel_GroupsByFingerprint_PreservesStageOrder_MergesRetryHistory()
    {
        string runDir = WriteSyntheticRun();

        ReportModel model = ReportModel.FromRunDirectory(runDir);

        Assert.Equal(new[] { "translate", "compile", "ilverify", "test-parity" }, model.StageOrder);
        Assert.Equal(3, model.TotalApps);
        Assert.Equal(1, model.GreenApps);
        Assert.False(model.Succeeded);

        // Apps sorted by id.
        Assert.Equal(
            new[] { "corpus/L1-Console", "corpus/L2-Library", "corpus/L3-Library" },
            model.Apps.Select(a => a.AppId).ToArray());

        // Shared fingerprint collapses to one gap with two occurrences.
        GapReport shared = Assert.Single(model.Gaps, g => g.Fingerprint == "sha256:shared00aaaa");
        Assert.Equal(
            new[] { "corpus/L2-Library", "corpus/L3-Library" },
            shared.Occurrences.Select(o => o.AppId).ToArray());

        // Stage order preserved, skipped stages present after the failing stage.
        AppReport l2 = model.Apps.Single(a => a.AppId == "corpus/L2-Library");
        Assert.Equal(
            new[] { "translate", "compile", "ilverify", "test-parity" },
            l2.Stages.Select(s => s.Stage).ToArray());
        Assert.Equal("failed", l2.Stages[0].Status);
        Assert.Equal("skipped", l2.Stages[1].Status);
        Assert.Equal("skipped", l2.Stages[3].Status);

        // Retry history merged + deduped across the two occurrences, sorted by runId.
        Assert.Equal(2, shared.RetryHistory.Count);
        Assert.Equal(new[] { "run-a", "run-b" }, shared.RetryHistory.Select(e => e.RunId).ToArray());

        // Gaps sorted by fingerprint.
        Assert.Equal(
            model.Gaps.Select(g => g.Fingerprint).OrderBy(f => f, StringComparer.Ordinal).ToArray(),
            model.Gaps.Select(g => g.Fingerprint).ToArray());
    }

    /// <summary>
    /// The JSON summary is schema-stable (gaps keyed by fingerprint), and
    /// re-serializing the same model is byte-identical (ADR-0115 §F).
    /// </summary>
    [Fact]
    public void JsonSummary_IsKeyedByFingerprint_AndByteStable()
    {
        string runDir = WriteSyntheticRun();
        ReportModel model = ReportModel.FromRunDirectory(runDir);

        string json = JsonSummaryWriter.Serialize(model);

        using var doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;
        foreach (string key in new[] { "runId", "timestamp", "gscVersion", "succeeded", "stageOrder", "apps", "gaps" })
        {
            Assert.True(root.TryGetProperty(key, out _), $"summary missing key '{key}'");
        }

        JsonElement gaps = root.GetProperty("gaps");
        Assert.All(
            gaps.EnumerateArray(),
            g => Assert.False(string.IsNullOrEmpty(g.GetProperty("fingerprint").GetString())));
        Assert.Contains(
            gaps.EnumerateArray(),
            g => g.GetProperty("fingerprint").GetString() == "sha256:shared00aaaa" &&
                g.GetProperty("occurrences").GetArrayLength() == 2);

        // Byte-stable on re-serialization of an independently-built model.
        ReportModel model2 = ReportModel.FromRunDirectory(runDir);
        Assert.Equal(json, JsonSummaryWriter.Serialize(model2));
    }

    /// <summary>
    /// The HTML report is self-contained (no external asset references) and the
    /// status matrix and gap blocks render (ADR-0115 §F).
    /// </summary>
    [Fact]
    public void HtmlReport_IsSelfContained_AndRendersMatrixAndGaps()
    {
        string runDir = WriteSyntheticRun();
        ReportModel model = ReportModel.FromRunDirectory(runDir);

        string html = HtmlReportWriter.Render(model);

        Assert.DoesNotContain("http://", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<link", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("src=", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("@import", html, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("<style>", html, StringComparison.Ordinal);
        Assert.Contains("class=\"matrix\"", html, StringComparison.Ordinal);
        Assert.Contains("corpus/L1-Console", html, StringComparison.Ordinal);
        Assert.Contains("aria-label=\"passed\"", html, StringComparison.Ordinal);
        Assert.Contains("aria-label=\"skipped\"", html, StringComparison.Ordinal);
        Assert.Contains("class=\"gap\"", html, StringComparison.Ordinal);
        Assert.Contains("sha256:shared00aaaa", html, StringComparison.Ordinal);
    }

    /// <summary>
    /// Every interpolated value is HTML-encoded: a gap whose diagnostic message
    /// and snippet carry <c>&lt;script&gt;</c>, <c>&amp;</c>, and <c>"</c>
    /// renders escaped, not as raw markup (ADR-0115 §F security requirement).
    /// </summary>
    [Fact]
    public void HtmlReport_HtmlEncodesInjectedMarkup()
    {
        string runDir = NewRunDir("encode");
        var run = new RunResult
        {
            RunId = "run-x",
            Timestamp = "2026-01-01T00:00:00Z",
            GscVersion = "9.9.9",
            Succeeded = false,
            Apps = new List<AppResult>
            {
                new AppResult
                {
                    AppId = "corpus/Evil",
                    Succeeded = false,
                    FailureCategory = "translation-unsupported",
                    Stages = AllStages("failed"),
                    Artifacts = new List<string> { "corpus_Evil/translate-evil.json" },
                    Fingerprints = new List<string> { "sha256:evil" },
                },
            },
        };
        WriteRunJson(runDir, run);

        var artifact = new TriageArtifact
        {
            RunId = "run-x",
            CorpusAppId = "corpus/Evil",
            Stage = "translate",
            Category = "translation-unsupported",
            Diagnostic = new TriageDiagnostic
            {
                Id = "CS2GS-UNSUPPORTED",
                Message = "<script>alert(\"x&y\")</script>",
                Severity = "error",
            },
            SourceLocation = new TriageSourceLocation { CsFile = "Evil.cs" },
            OffendingCSharpConstruct = new TriageOffendingConstruct
            {
                Kind = "Construct",
                Snippet = "var a = b < c && d > \"e\";",
            },
            SuggestedIssue = new TriageSuggestedIssue
            {
                Title = "<b>bad & title</b>",
                Body = "body with <img> & \"quotes\"",
                Labels = new List<string> { "Oats" },
            },
            Fingerprint = "sha256:evil",
        };
        WriteArtifact(runDir, "corpus_Evil/translate-evil.json", artifact);

        ReportModel model = ReportModel.FromRunDirectory(runDir);
        string html = HtmlReportWriter.Render(model);

        Assert.DoesNotContain("<script>alert", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<b>bad & title</b>", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<img>", html, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;", html, StringComparison.Ordinal);
        Assert.Contains("&lt;b&gt;bad &amp; title&lt;/b&gt;", html, StringComparison.Ordinal);
    }

    /// <summary>
    /// The HTML render is deterministic: the same model yields byte-identical
    /// output (ADR-0115 §F diffability requirement).
    /// </summary>
    [Fact]
    public void HtmlReport_IsDeterministic()
    {
        string runDir = WriteSyntheticRun();

        string first = HtmlReportWriter.Render(ReportModel.FromRunDirectory(runDir));
        string second = HtmlReportWriter.Render(ReportModel.FromRunDirectory(runDir));

        Assert.Equal(first, second);
    }

    /// <summary>
    /// Both writers persist <c>report.html</c> and <c>summary.json</c> into the
    /// run directory (ADR-0115 §F).
    /// </summary>
    [Fact]
    public void Writers_PersistBothArtifacts()
    {
        string runDir = WriteSyntheticRun();
        ReportModel model = ReportModel.FromRunDirectory(runDir);

        string htmlPath = HtmlReportWriter.Write(model, runDir);
        string jsonPath = JsonSummaryWriter.Write(model, runDir);

        Assert.True(File.Exists(htmlPath));
        Assert.True(File.Exists(jsonPath));
        Assert.Equal("report.html", Path.GetFileName(htmlPath));
        Assert.Equal("summary.json", Path.GetFileName(jsonPath));
    }

    /// <summary>
    /// The CLI <c>report --run &lt;dir&gt;</c> verb regenerates both
    /// <c>report.html</c> and <c>summary.json</c> from an existing run directory
    /// without re-running the pipeline (ADR-0115 §F).
    /// </summary>
    [Fact]
    public void Cli_ReportVerb_RegeneratesBothArtifacts()
    {
        string cliDll = FindCliDll();
        Assert.True(cliDll is not null, "cs2gs.dll not found; build the solution first.");

        string runDir = WriteSyntheticRun();
        File.Delete(Path.Combine(runDir, "summary.json"));
        Assert.False(File.Exists(Path.Combine(runDir, "report.html")));

        var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(cliDll);
        psi.ArgumentList.Add("report");
        psi.ArgumentList.Add("--run");
        psi.ArgumentList.Add(runDir);

        using var process = System.Diagnostics.Process.Start(psi);
        string stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit();

        Assert.Equal(0, process.ExitCode);
        Assert.True(File.Exists(Path.Combine(runDir, "report.html")), stdout);
        Assert.True(File.Exists(Path.Combine(runDir, "summary.json")), stdout);
    }

    private static string FindCliDll()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Cs2Gs.Cli", "cs2gs.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static string WriteSyntheticRun()
    {
        string runDir = NewRunDir("model");

        var run = new RunResult
        {
            RunId = "2026-02-02T00-00-00Z_abc123",
            Timestamp = "2026-02-02T00:00:00Z",
            GscVersion = "0.2.0+test",
            GscPath = "/path/to/gsc.dll",
            Succeeded = false,
            Apps = new List<AppResult>
            {
                new AppResult
                {
                    AppId = "corpus/L1-Console",
                    Succeeded = true,
                    Stages = AllStages("passed"),
                },
                new AppResult
                {
                    AppId = "corpus/L3-Library",
                    Succeeded = false,
                    FailureCategory = "translation-unsupported",
                    Stages = new List<StageResult>
                    {
                        new StageResult { Stage = "translate", Status = "failed", ArtifactCount = 2 },
                        new StageResult { Stage = "compile", Status = "skipped" },
                        new StageResult { Stage = "ilverify", Status = "skipped" },
                        new StageResult { Stage = "test-parity", Status = "skipped" },
                    },
                    Artifacts = new List<string>
                    {
                        "corpus_L3-Library/translate-unique3.json",
                        "corpus_L3-Library/translate-shared.json",
                    },
                    Fingerprints = new List<string> { "sha256:unique30bbbb", "sha256:shared00aaaa" },
                },
                new AppResult
                {
                    AppId = "corpus/L2-Library",
                    Succeeded = false,
                    FailureCategory = "translation-unsupported",
                    Stages = new List<StageResult>
                    {
                        new StageResult { Stage = "translate", Status = "failed", ArtifactCount = 1 },
                        new StageResult { Stage = "compile", Status = "skipped" },
                        new StageResult { Stage = "ilverify", Status = "skipped" },
                        new StageResult { Stage = "test-parity", Status = "skipped" },
                    },
                    Artifacts = new List<string> { "corpus_L2-Library/translate-shared.json" },
                    Fingerprints = new List<string> { "sha256:shared00aaaa" },
                },
            },
        };
        WriteRunJson(runDir, run);

        WriteArtifact(
            runDir,
            "corpus_L3-Library/translate-unique3.json",
            MakeArtifact("corpus/L3-Library", "sha256:unique30bbbb", "UniqueKind", retry: null));
        WriteArtifact(
            runDir,
            "corpus_L3-Library/translate-shared.json",
            MakeArtifact(
                "corpus/L3-Library",
                "sha256:shared00aaaa",
                "SharedKind",
                retry: new TriageRetryEntry { RunId = "run-b", GscVersion = "0.1.0", Result = "fail" }));
        WriteArtifact(
            runDir,
            "corpus_L2-Library/translate-shared.json",
            MakeArtifact(
                "corpus/L2-Library",
                "sha256:shared00aaaa",
                "SharedKind",
                retry: new TriageRetryEntry { RunId = "run-a", GscVersion = "0.0.9", Result = "fail" }));

        return runDir;
    }

    private static TriageArtifact MakeArtifact(string appId, string fingerprint, string kind, TriageRetryEntry retry)
    {
        var artifact = new TriageArtifact
        {
            RunId = "2026-02-02T00-00-00Z_abc123",
            Timestamp = "2026-02-02T00:00:00Z",
            GscVersion = "0.2.0+test",
            CorpusAppId = appId,
            Stage = "translate",
            Category = "translation-unsupported",
            Diagnostic = new TriageDiagnostic
            {
                Id = "CS2GS-UNSUPPORTED",
                Message = $"Unsupported {kind}",
                Severity = "error",
            },
            SourceLocation = new TriageSourceLocation { CsFile = $"{appId}/Src.cs" },
            OffendingCSharpConstruct = new TriageOffendingConstruct { Kind = kind, Snippet = "snippet" },
            SuggestedIssue = new TriageSuggestedIssue
            {
                Title = $"[cs2gs] {kind}",
                Body = "body",
                Labels = new List<string> { "Oats" },
            },
            Fingerprint = fingerprint,
        };

        if (retry is not null)
        {
            artifact.RetryHistory.Add(retry);
        }

        return artifact;
    }

    private static List<StageResult> AllStages(string status)
    {
        return new List<StageResult>
        {
            new StageResult { Stage = "translate", Status = status },
            new StageResult { Stage = "compile", Status = status },
            new StageResult { Stage = "ilverify", Status = status },
            new StageResult { Stage = "test-parity", Status = status },
        };
    }

    private static void WriteRunJson(string runDir, RunResult run)
    {
        File.WriteAllText(
            Path.Combine(runDir, "run.json"),
            JsonSerializer.Serialize(run, TriageSerialization.Options));
    }

    private static void WriteArtifact(string runDir, string relative, TriageArtifact artifact)
    {
        string path = Path.Combine(runDir, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, JsonSerializer.Serialize(artifact, TriageSerialization.Options));
    }

    private static string NewRunDir(string label)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory, "report-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }
}
