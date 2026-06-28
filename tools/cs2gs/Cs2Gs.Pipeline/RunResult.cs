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

    /// <summary>Gets or sets the per-app results.</summary>
    [JsonPropertyName("apps")]
    [JsonPropertyOrder(5)]
    public List<AppResult> Apps { get; set; } = new();
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

    /// <summary>Gets or sets the category of the first failing stage, or null when green.</summary>
    [JsonPropertyName("failureCategory")]
    [JsonPropertyOrder(2)]
    public string FailureCategory { get; set; }

    /// <summary>Gets or sets the per-stage results, in execution order.</summary>
    [JsonPropertyName("stages")]
    [JsonPropertyOrder(3)]
    public List<StageResult> Stages { get; set; } = new();

    /// <summary>Gets or sets the run-relative paths of the triage artifacts produced for this app.</summary>
    [JsonPropertyName("artifacts")]
    [JsonPropertyOrder(4)]
    public List<string> Artifacts { get; set; } = new();

    /// <summary>Gets or sets the distinct fingerprints captured for this app.</summary>
    [JsonPropertyName("fingerprints")]
    [JsonPropertyOrder(5)]
    public List<string> Fingerprints { get; set; } = new();
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
