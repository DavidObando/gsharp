// <copyright file="TriageArtifact.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The structured, machine-readable triage artifact written once per failure
/// (ADR-0115 §D.1, schema v1.0). The property order and names match the schema
/// exactly so the external issue-filing agent and the later report step can
/// consume artifacts deterministically. Serialized with
/// <see cref="TriageSerialization.Options"/>.
/// </summary>
public sealed class TriageArtifact
{
    /// <summary>Gets or sets the schema version (always <c>"1.0"</c>).</summary>
    [JsonPropertyName("schemaVersion")]
    [JsonPropertyOrder(0)]
    public string SchemaVersion { get; set; } = "1.0";

    /// <summary>Gets or sets the run id (e.g. <c>2026-06-21T20-00-00Z_3f9c1a</c>).</summary>
    [JsonPropertyName("runId")]
    [JsonPropertyOrder(1)]
    public string RunId { get; set; }

    /// <summary>Gets or sets the ISO-8601 UTC timestamp of the run.</summary>
    [JsonPropertyName("timestamp")]
    [JsonPropertyOrder(2)]
    public string Timestamp { get; set; }

    /// <summary>Gets or sets the <c>gsc</c> version the failure was observed against.</summary>
    [JsonPropertyName("gscVersion")]
    [JsonPropertyOrder(3)]
    public string GscVersion { get; set; }

    /// <summary>Gets or sets the corpus app id (e.g. <c>corpus/L2-Library</c>).</summary>
    [JsonPropertyName("corpusAppId")]
    [JsonPropertyOrder(4)]
    public string CorpusAppId { get; set; }

    /// <summary>Gets or sets the stage that failed (<c>translate</c>/<c>compile</c>/…).</summary>
    [JsonPropertyName("stage")]
    [JsonPropertyOrder(5)]
    public string Stage { get; set; }

    /// <summary>Gets or sets the triage category.</summary>
    [JsonPropertyName("category")]
    [JsonPropertyOrder(6)]
    public string Category { get; set; }

    /// <summary>Gets or sets the diagnostic id/message/severity.</summary>
    [JsonPropertyName("diagnostic")]
    [JsonPropertyOrder(7)]
    public TriageDiagnostic Diagnostic { get; set; }

    /// <summary>Gets or sets the emitted-G# and originating-C# source locations.</summary>
    [JsonPropertyName("sourceLocation")]
    [JsonPropertyOrder(8)]
    public TriageSourceLocation SourceLocation { get; set; }

    /// <summary>Gets or sets the offending C# construct kind plus a minimal snippet.</summary>
    [JsonPropertyName("offendingCSharpConstruct")]
    [JsonPropertyOrder(9)]
    public TriageOffendingConstruct OffendingCSharpConstruct { get; set; }

    /// <summary>Gets or sets the pre-rendered, ready-to-file issue.</summary>
    [JsonPropertyName("suggestedIssue")]
    [JsonPropertyOrder(10)]
    public TriageSuggestedIssue SuggestedIssue { get; set; }

    /// <summary>Gets or sets the dedup fingerprint (ADR-0115 §D.2).</summary>
    [JsonPropertyName("fingerprint")]
    [JsonPropertyOrder(11)]
    public string Fingerprint { get; set; }

    /// <summary>Gets or sets the prior <c>{runId, gscVersion, result}</c> records for this fingerprint.</summary>
    [JsonPropertyName("retryHistory")]
    [JsonPropertyOrder(12)]
    public List<TriageRetryEntry> RetryHistory { get; set; } = new List<TriageRetryEntry>();
}

/// <summary>
/// The G# diagnostic id/message/severity carried by a triage artifact
/// (ADR-0115 §D.1).
/// </summary>
public sealed class TriageDiagnostic
{
    /// <summary>Gets or sets the diagnostic id (e.g. <c>GS0313</c>).</summary>
    [JsonPropertyName("id")]
    [JsonPropertyOrder(0)]
    public string Id { get; set; }

    /// <summary>Gets or sets the diagnostic message.</summary>
    [JsonPropertyName("message")]
    [JsonPropertyOrder(1)]
    public string Message { get; set; }

    /// <summary>Gets or sets the diagnostic severity (e.g. <c>error</c>).</summary>
    [JsonPropertyName("severity")]
    [JsonPropertyOrder(2)]
    public string Severity { get; set; }
}

/// <summary>
/// Both ends of the C#↔G# source map for a failure: the emitted-<c>.gs</c>
/// position and the originating C# position. Sub-fields are
/// <see langword="null"/> when a precise mapping is not available — see
/// <see cref="MigrationPipeline"/> for the documented null rules (ADR-0115 §D.1).
/// </summary>
public sealed class TriageSourceLocation
{
    /// <summary>Gets or sets the emitted G# file (relative to the run dir), or null.</summary>
    [JsonPropertyName("gsFile")]
    [JsonPropertyOrder(0)]
    public string GsFile { get; set; }

    /// <summary>Gets or sets the 1-based G# line, or null.</summary>
    [JsonPropertyName("gsLine")]
    [JsonPropertyOrder(1)]
    public int? GsLine { get; set; }

    /// <summary>Gets or sets the 1-based G# column, or null.</summary>
    [JsonPropertyName("gsColumn")]
    [JsonPropertyOrder(2)]
    public int? GsColumn { get; set; }

    /// <summary>Gets or sets the originating C# file, or null.</summary>
    [JsonPropertyName("csFile")]
    [JsonPropertyOrder(3)]
    public string CsFile { get; set; }

    /// <summary>Gets or sets the 1-based C# line, or null.</summary>
    [JsonPropertyName("csLine")]
    [JsonPropertyOrder(4)]
    public int? CsLine { get; set; }

    /// <summary>Gets or sets the 1-based C# column, or null.</summary>
    [JsonPropertyName("csColumn")]
    [JsonPropertyOrder(5)]
    public int? CsColumn { get; set; }
}

/// <summary>
/// The offending construct kind plus a minimal snippet (ADR-0115 §D.1). For
/// stage 1 this is the C# construct; for stage 2 — where no precise C# map
/// exists — it is the emitted G# construct that <c>gsc</c> flagged.
/// </summary>
public sealed class TriageOffendingConstruct
{
    /// <summary>Gets or sets the construct kind (e.g. <c>RecordDeclaration</c>).</summary>
    [JsonPropertyName("kind")]
    [JsonPropertyOrder(0)]
    public string Kind { get; set; }

    /// <summary>Gets or sets a minimal one-line snippet of the construct.</summary>
    [JsonPropertyName("snippet")]
    [JsonPropertyOrder(1)]
    public string Snippet { get; set; }
}

/// <summary>
/// A pre-rendered, human-fileable issue the external agent can file as-is
/// (ADR-0115 §D.1). The <c>labels</c> list always contains <c>Oats</c>.
/// </summary>
public sealed class TriageSuggestedIssue
{
    /// <summary>Gets or sets the issue title.</summary>
    [JsonPropertyName("title")]
    [JsonPropertyOrder(0)]
    public string Title { get; set; }

    /// <summary>Gets or sets the issue body.</summary>
    [JsonPropertyName("body")]
    [JsonPropertyOrder(1)]
    public string Body { get; set; }

    /// <summary>Gets or sets the issue labels (always includes <c>Oats</c>).</summary>
    [JsonPropertyName("labels")]
    [JsonPropertyOrder(2)]
    public List<string> Labels { get; set; } = new List<string>();
}

/// <summary>
/// One prior-run record in a fingerprint's <c>retryHistory</c> (ADR-0115 §D.1).
/// </summary>
public sealed class TriageRetryEntry
{
    /// <summary>Gets or sets the prior run id.</summary>
    [JsonPropertyName("runId")]
    [JsonPropertyOrder(0)]
    public string RunId { get; set; }

    /// <summary>Gets or sets the prior <c>gsc</c> version.</summary>
    [JsonPropertyName("gscVersion")]
    [JsonPropertyOrder(1)]
    public string GscVersion { get; set; }

    /// <summary>Gets or sets the prior result (<c>fail</c> or <c>pass</c>).</summary>
    [JsonPropertyName("result")]
    [JsonPropertyOrder(2)]
    public string Result { get; set; }
}
