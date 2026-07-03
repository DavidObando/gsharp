// <copyright file="ReportModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Cs2Gs.Pipeline;

namespace Cs2Gs.Report;

/// <summary>
/// The aggregated, render-ready view of one completed migration run (ADR-0115
/// §F): run-level provenance, the per-app × per-stage status matrix (stages in
/// execution order, including <c>skipped</c>), and the discovered-gap list
/// grouped by <c>fingerprint</c> (§D.2) with per-app occurrences and a merged
/// <c>retryHistory</c>. Built once from a run directory's <c>run.json</c> plus
/// the referenced triage artifacts (§D.1) and consumed by both
/// <see cref="JsonSummaryWriter"/> and <see cref="HtmlReportWriter"/>.
/// </summary>
public sealed class ReportModel
{
    /// <summary>Gets or sets the run id.</summary>
    [JsonPropertyName("runId")]
    [JsonPropertyOrder(0)]
    public string RunId { get; set; }

    /// <summary>Gets or sets the ISO-8601 UTC run timestamp.</summary>
    [JsonPropertyName("timestamp")]
    [JsonPropertyOrder(1)]
    public string Timestamp { get; set; }

    /// <summary>Gets or sets the compiler version the run executed against.</summary>
    [JsonPropertyName("gscVersion")]
    [JsonPropertyOrder(2)]
    public string GscVersion { get; set; }

    /// <summary>Gets or sets a value indicating whether every app passed every stage.</summary>
    [JsonPropertyName("succeeded")]
    [JsonPropertyOrder(3)]
    public bool Succeeded { get; set; }

    /// <summary>Gets or sets the total number of apps in the run.</summary>
    [JsonPropertyName("totalApps")]
    [JsonPropertyOrder(4)]
    public int TotalApps { get; set; }

    /// <summary>Gets or sets the number of apps green across every stage.</summary>
    [JsonPropertyName("greenApps")]
    [JsonPropertyOrder(5)]
    public int GreenApps { get; set; }

    /// <summary>Gets or sets the stage names in execution order (Translate→Compile→IlVerify→TestParity).</summary>
    [JsonPropertyName("stageOrder")]
    [JsonPropertyOrder(6)]
    public List<string> StageOrder { get; set; } = new List<string>();

    /// <summary>Gets or sets the per-app results, sorted by app id, each with its stages in execution order.</summary>
    [JsonPropertyName("apps")]
    [JsonPropertyOrder(7)]
    public List<AppReport> Apps { get; set; } = new List<AppReport>();

    /// <summary>Gets or sets the discovered gaps, grouped by fingerprint and sorted by fingerprint.</summary>
    [JsonPropertyName("gaps")]
    [JsonPropertyOrder(8)]
    public List<GapReport> Gaps { get; set; } = new List<GapReport>();

    /// <summary>
    /// Gets or sets the number of triage artifact paths referenced by <c>run.json</c>
    /// that could not be found on disk when the model was built. A run whose apps
    /// reference artifacts that are missing (deleted, not yet copied, or a
    /// truncated/partial run) has incomplete gap data even when
    /// <see cref="Gaps"/> ends up empty; consumers must not read an empty
    /// <see cref="Gaps"/> list as "no gaps" unless this is also zero. See
    /// <see cref="IsGreen"/>.
    /// </summary>
    [JsonPropertyName("missingArtifactCount")]
    [JsonPropertyOrder(9)]
    public int MissingArtifactCount { get; set; }

    /// <summary>
    /// Gets a value indicating whether the run is genuinely green: it must be
    /// based on positive evidence — the run itself reported success
    /// (<see cref="Succeeded"/>), every referenced triage artifact was
    /// readable (<see cref="MissingArtifactCount"/> is zero), and no gaps were
    /// discovered (<see cref="Gaps"/> is empty) — never on the mere absence of
    /// gap data, which can also mean the triage artifacts were missing or the
    /// run failed outright.
    /// </summary>
    [JsonPropertyName("isGreen")]
    [JsonPropertyOrder(10)]
    public bool IsGreen => this.Succeeded && this.MissingArtifactCount == 0 && this.Gaps.Count == 0;

    /// <summary>
    /// Gets or sets the absolute run directory the model was built from (i.e.
    /// the directory <see cref="AppReport.Artifacts"/> paths are relative to).
    /// Not part of the <c>summary.json</c> schema; used only so
    /// <see cref="HtmlReportWriter"/> can re-resolve artifact links when
    /// <c>report.html</c> is written somewhere other than the run dir.
    /// </summary>
    [JsonIgnore]
    public string RunDir { get; set; }

    /// <summary>
    /// Builds a <see cref="ReportModel"/> from a run directory by reading its
    /// <c>run.json</c> and every referenced triage artifact.
    /// </summary>
    /// <param name="runDir">The run directory (contains <c>run.json</c>).</param>
    /// <returns>The aggregated model.</returns>
    public static ReportModel FromRunDirectory(string runDir)
    {
        if (string.IsNullOrEmpty(runDir))
        {
            throw new ArgumentException("Run directory is required.", nameof(runDir));
        }

        string runJsonPath = Path.Combine(runDir, "run.json");
        if (!File.Exists(runJsonPath))
        {
            throw new FileNotFoundException("run.json not found in run directory.", runJsonPath);
        }

        RunResult run = JsonSerializer.Deserialize<RunResult>(
            File.ReadAllText(runJsonPath), TriageSerialization.Options);
        if (run is null)
        {
            throw new InvalidDataException($"run.json at '{runJsonPath}' did not deserialize.");
        }

        return Build(run, runDir);
    }

    /// <summary>
    /// Builds a <see cref="ReportModel"/> from an in-memory <see cref="RunResult"/>,
    /// loading the referenced triage artifacts relative to <paramref name="runDir"/>.
    /// </summary>
    /// <param name="run">The deserialized run summary.</param>
    /// <param name="runDir">The run directory used to resolve artifact paths.</param>
    /// <returns>The aggregated model.</returns>
    public static ReportModel Build(RunResult run, string runDir)
    {
        if (run is null)
        {
            throw new ArgumentNullException(nameof(run));
        }

        List<string> stageOrder = CanonicalStageOrder();

        var apps = new List<AppReport>();
        var artifacts = new List<(string AppId, TriageArtifact Artifact)>();
        int missingArtifactCount = 0;

        foreach (AppResult app in run.Apps.OrderBy(a => a.AppId, StringComparer.Ordinal))
        {
            apps.Add(BuildAppReport(app, stageOrder));

            foreach (string relative in app.Artifacts ?? new List<string>())
            {
                string artifactPath = Path.Combine(runDir, relative.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(artifactPath))
                {
                    missingArtifactCount++;
                    Console.Error.WriteLine(
                        $"cs2gs: warning: triage artifact '{relative}' referenced by app '{app.AppId}' is missing under {runDir}; gap data is incomplete.");
                    continue;
                }

                TriageArtifact artifact = JsonSerializer.Deserialize<TriageArtifact>(
                    File.ReadAllText(artifactPath), TriageSerialization.Options);
                if (artifact is null)
                {
                    missingArtifactCount++;
                    Console.Error.WriteLine(
                        $"cs2gs: warning: triage artifact '{relative}' referenced by app '{app.AppId}' did not deserialize; gap data is incomplete.");
                    continue;
                }

                artifacts.Add((app.AppId, artifact));
            }
        }

        int greenApps = run.Apps.Count(a => a.Succeeded);

        return new ReportModel
        {
            RunId = run.RunId,
            Timestamp = run.Timestamp,
            GscVersion = run.GscVersion,
            Succeeded = run.Succeeded,
            TotalApps = run.Apps.Count,
            GreenApps = greenApps,
            StageOrder = stageOrder,
            Apps = apps,
            Gaps = GroupGaps(artifacts),
            MissingArtifactCount = missingArtifactCount,
            RunDir = Path.GetFullPath(runDir),
        };
    }

    private static List<string> CanonicalStageOrder()
    {
        return Enum.GetValues<MigrationStageKind>()
            .Select(TriageSerialization.StageName)
            .ToList();
    }

    private static AppReport BuildAppReport(AppResult app, List<string> stageOrder)
    {
        var byName = (app.Stages ?? new List<StageResult>())
            .Where(s => s.Stage is not null)
            .GroupBy(s => s.Stage, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        var stages = new List<StageResult>();
        foreach (string stageName in stageOrder)
        {
            if (byName.TryGetValue(stageName, out StageResult stage))
            {
                stages.Add(new StageResult
                {
                    Stage = stageName,
                    Status = stage.Status ?? "skipped",
                    ArtifactCount = stage.ArtifactCount,
                });
            }
            else
            {
                stages.Add(new StageResult
                {
                    Stage = stageName,
                    Status = "skipped",
                    ArtifactCount = 0,
                });
            }
        }

        return new AppReport
        {
            AppId = app.AppId,
            Succeeded = app.Succeeded,
            FailureCategory = app.FailureCategory,
            Stages = stages,
            Artifacts = (app.Artifacts ?? new List<string>())
                .OrderBy(a => a, StringComparer.Ordinal).ToList(),
            Fingerprints = (app.Fingerprints ?? new List<string>())
                .OrderBy(f => f, StringComparer.Ordinal).ToList(),
        };
    }

    private static List<GapReport> GroupGaps(List<(string AppId, TriageArtifact Artifact)> artifacts)
    {
        var gaps = new List<GapReport>();

        foreach (var group in artifacts
            .GroupBy(a => a.Artifact.Fingerprint, StringComparer.Ordinal)
            .OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            // Choose a deterministic representative: the lowest app id, then artifact.
            var ordered = group
                .OrderBy(a => a.AppId, StringComparer.Ordinal)
                .ThenBy(a => a.Artifact.CorpusAppId, StringComparer.Ordinal)
                .ToList();
            TriageArtifact head = ordered[0].Artifact;

            var occurrences = ordered
                .Select(a => new GapOccurrence
                {
                    AppId = a.AppId,
                    SourceLocation = a.Artifact.SourceLocation,
                })
                .OrderBy(o => o.AppId, StringComparer.Ordinal)
                .ToList();

            gaps.Add(new GapReport
            {
                Fingerprint = group.Key,
                Category = head.Category,
                Stage = head.Stage,
                Diagnostic = head.Diagnostic,
                OffendingCSharpConstruct = head.OffendingCSharpConstruct,
                SuggestedIssue = head.SuggestedIssue,
                Occurrences = occurrences,
                RetryHistory = MergeRetryHistory(ordered.Select(a => a.Artifact)),
            });
        }

        return gaps;
    }

    private static List<TriageRetryEntry> MergeRetryHistory(IEnumerable<TriageArtifact> artifacts)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var merged = new List<TriageRetryEntry>();

        foreach (TriageArtifact artifact in artifacts)
        {
            foreach (TriageRetryEntry entry in artifact.RetryHistory ?? new List<TriageRetryEntry>())
            {
                string key = (entry.RunId ?? string.Empty) + "|" +
                    (entry.GscVersion ?? string.Empty) + "|" +
                    (entry.Result ?? string.Empty);
                if (seen.Add(key))
                {
                    merged.Add(entry);
                }
            }
        }

        return merged
            .OrderBy(e => e.RunId, StringComparer.Ordinal)
            .ThenBy(e => e.GscVersion, StringComparer.Ordinal)
            .ThenBy(e => e.Result, StringComparer.Ordinal)
            .ToList();
    }
}

/// <summary>
/// One app's row in the status matrix: its id, overall result, and per-stage
/// statuses in execution order (ADR-0115 §F).
/// </summary>
public sealed class AppReport
{
    /// <summary>Gets or sets the corpus app id.</summary>
    [JsonPropertyName("appId")]
    [JsonPropertyOrder(0)]
    public string AppId { get; set; }

    /// <summary>Gets or sets a value indicating whether the app passed every stage.</summary>
    [JsonPropertyName("succeeded")]
    [JsonPropertyOrder(1)]
    public bool Succeeded { get; set; }

    /// <summary>Gets or sets the first failing stage's category, or null when green.</summary>
    [JsonPropertyName("failureCategory")]
    [JsonPropertyOrder(2)]
    public string FailureCategory { get; set; }

    /// <summary>Gets or sets the per-stage statuses, in execution order.</summary>
    [JsonPropertyName("stages")]
    [JsonPropertyOrder(3)]
    public List<StageResult> Stages { get; set; } = new List<StageResult>();

    /// <summary>Gets or sets the run-relative triage artifact paths for this app.</summary>
    [JsonPropertyName("artifacts")]
    [JsonPropertyOrder(4)]
    public List<string> Artifacts { get; set; } = new List<string>();

    /// <summary>Gets or sets the distinct fingerprints captured for this app.</summary>
    [JsonPropertyName("fingerprints")]
    [JsonPropertyOrder(5)]
    public List<string> Fingerprints { get; set; } = new List<string>();
}

/// <summary>
/// One discovered gap (ADR-0115 §F): a single fingerprint, the representative
/// category/stage/diagnostic/construct and pre-rendered issue, every per-app
/// occurrence, and the merged retry history.
/// </summary>
public sealed class GapReport
{
    /// <summary>Gets or sets the dedup fingerprint (the gap key, §D.2).</summary>
    [JsonPropertyName("fingerprint")]
    [JsonPropertyOrder(0)]
    public string Fingerprint { get; set; }

    /// <summary>Gets or sets the triage category.</summary>
    [JsonPropertyName("category")]
    [JsonPropertyOrder(1)]
    public string Category { get; set; }

    /// <summary>Gets or sets the stage that produced the gap.</summary>
    [JsonPropertyName("stage")]
    [JsonPropertyOrder(2)]
    public string Stage { get; set; }

    /// <summary>Gets or sets the diagnostic id/message/severity.</summary>
    [JsonPropertyName("diagnostic")]
    [JsonPropertyOrder(3)]
    public TriageDiagnostic Diagnostic { get; set; }

    /// <summary>Gets or sets the offending construct kind plus a minimal snippet.</summary>
    [JsonPropertyName("offendingCSharpConstruct")]
    [JsonPropertyOrder(4)]
    public TriageOffendingConstruct OffendingCSharpConstruct { get; set; }

    /// <summary>Gets or sets the pre-rendered, ready-to-file issue.</summary>
    [JsonPropertyName("suggestedIssue")]
    [JsonPropertyOrder(5)]
    public TriageSuggestedIssue SuggestedIssue { get; set; }

    /// <summary>Gets or sets the per-app occurrences (appId + source location), sorted by app id.</summary>
    [JsonPropertyName("occurrences")]
    [JsonPropertyOrder(6)]
    public List<GapOccurrence> Occurrences { get; set; } = new List<GapOccurrence>();

    /// <summary>Gets or sets the merged, deduped retry history for this fingerprint.</summary>
    [JsonPropertyName("retryHistory")]
    [JsonPropertyOrder(7)]
    public List<TriageRetryEntry> RetryHistory { get; set; } = new List<TriageRetryEntry>();
}

/// <summary>
/// One occurrence of a gap: the corpus app that hit it plus the source-map
/// location recorded for that app (ADR-0115 §D.1/§F).
/// </summary>
public sealed class GapOccurrence
{
    /// <summary>Gets or sets the corpus app id that hit this gap.</summary>
    [JsonPropertyName("appId")]
    [JsonPropertyOrder(0)]
    public string AppId { get; set; }

    /// <summary>Gets or sets the source-map location for this occurrence.</summary>
    [JsonPropertyName("sourceLocation")]
    [JsonPropertyOrder(1)]
    public TriageSourceLocation SourceLocation { get; set; }
}
