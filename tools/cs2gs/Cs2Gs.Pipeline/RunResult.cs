// <copyright file="RunResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The machine-readable summary of one whole-run pipeline execution: provenance
/// plus a per-app result list. This is the stable artifact the later
/// <c>Cs2Gs.Report</c> step aggregates (ADR-0115 §F); serialized with
/// <see cref="TriageSerialization.Options"/>.
/// </summary>
public sealed class RunResult
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

    /// <summary>Gets or sets the resolved <c>gsc.dll</c> path.</summary>
    [JsonPropertyName("gscPath")]
    [JsonPropertyOrder(3)]
    public string GscPath { get; set; }

    /// <summary>Gets or sets a value indicating whether every app passed every run stage.</summary>
    [JsonPropertyName("succeeded")]
    [JsonPropertyOrder(4)]
    public bool Succeeded { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether no app failed but at least one
    /// app has an unverified stage (a genuinely-unavailable dependency, e.g.
    /// no locally-built SDK). Mutually exclusive with a "failed" run: a
    /// skipped stage never overrides a failed one (ADR-0115 §C). Distinct
    /// from <see cref="Succeeded"/> so the aggregate
    /// rollup cannot render "not verified" as verified-green (issue #1831,
    /// following the per-stage fix in issue #1749).
    /// </summary>
    [JsonPropertyName("unverified")]
    [JsonPropertyOrder(5)]
    public bool Unverified { get; set; }

    /// <summary>Gets or sets the per-app results.</summary>
    [JsonPropertyName("apps")]
    [JsonPropertyOrder(6)]
    public List<AppResult> Apps { get; set; } = new List<AppResult>();
}

/// <summary>
/// The result of migrating one corpus app: its id, per-stage statuses, and the
/// triage artifact file paths produced (ADR-0115 §C/§D/§F).
/// </summary>
public sealed class AppResult
{
    /// <summary>Gets or sets the corpus app id.</summary>
    [JsonPropertyName("appId")]
    [JsonPropertyOrder(0)]
    public string AppId { get; set; }

    /// <summary>Gets or sets a value indicating whether the app passed every executed stage.</summary>
    [JsonPropertyName("succeeded")]
    [JsonPropertyOrder(1)]
    public bool Succeeded { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether no stage failed but at least
    /// one stage is <c>skipped</c> (a genuinely-unavailable dependency, not a
    /// pass). Never <see langword="true"/> when <see cref="Succeeded"/> is
    /// <see langword="false"/> — a failed stage always takes precedence
    /// (ADR-0115 §C). This is the app-level counterpart of the per-stage
    /// "skipped" status (issue #1749); it exists so the aggregate rollup does
    /// not render an unverified app as green (issue #1831).
    /// </summary>
    [JsonPropertyName("unverified")]
    [JsonPropertyOrder(2)]
    public bool Unverified { get; set; }

    /// <summary>Gets or sets the category of the first failing stage, or null when green.</summary>
    [JsonPropertyName("failureCategory")]
    [JsonPropertyOrder(3)]
    public string FailureCategory { get; set; }

    /// <summary>Gets or sets the per-stage results, in execution order.</summary>
    [JsonPropertyName("stages")]
    [JsonPropertyOrder(4)]
    public List<StageResult> Stages { get; set; } = new List<StageResult>();

    /// <summary>Gets or sets the run-relative paths of the triage artifacts produced for this app.</summary>
    [JsonPropertyName("artifacts")]
    [JsonPropertyOrder(5)]
    public List<string> Artifacts { get; set; } = new List<string>();

    /// <summary>Gets or sets the distinct fingerprints captured for this app.</summary>
    [JsonPropertyName("fingerprints")]
    [JsonPropertyOrder(6)]
    public List<string> Fingerprints { get; set; } = new List<string>();
}

/// <summary>
/// The status of one stage within one app's migration (ADR-0115 §C).
/// </summary>
public sealed class StageResult
{
    /// <summary>Gets or sets the stage name (<c>translate</c>/<c>compile</c>/…).</summary>
    [JsonPropertyName("stage")]
    [JsonPropertyOrder(0)]
    public string Stage { get; set; }

    /// <summary>Gets or sets the stage status (<c>passed</c>/<c>failed</c>/<c>skipped</c>).</summary>
    [JsonPropertyName("status")]
    [JsonPropertyOrder(1)]
    public string Status { get; set; }

    /// <summary>Gets or sets the number of triage artifacts the stage produced.</summary>
    [JsonPropertyName("artifactCount")]
    [JsonPropertyOrder(2)]
    public int ArtifactCount { get; set; }
}
