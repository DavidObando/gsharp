// <copyright file="TriageArtifact.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System.Collections.Generic
import System.Text.Json.Serialization

/// The structured, machine-readable triage artifact written once per failure
/// (ADR-0115 §D.1, schema v1.0). The property order and names match the schema
/// exactly so the external issue-filing agent and the later report step can
/// consume artifacts deterministically. Serialized with
/// (cref:TriageSerialization.Options).
class TriageArtifact {
    /// Gets or sets the schema version (always `"1.0"`).
    private var _schemaVersion string = "1.0"

    @JsonPropertyName("schemaVersion")
    @JsonPropertyOrder(int32(0))
    prop SchemaVersion string {
        get {
            return _schemaVersion
        }
        set {
            _schemaVersion = value
        }
    }

    /// Gets or sets the run id (e.g. `2026-06-21T20-00-00Z_3f9c1a`).
    @JsonPropertyName("runId")
    @JsonPropertyOrder(int32(1))
    prop RunId string

    /// Gets or sets the ISO-8601 UTC timestamp of the run.
    @JsonPropertyName("timestamp")
    @JsonPropertyOrder(int32(2))
    prop Timestamp string

    /// Gets or sets the `gsc` version the failure was observed against.
    @JsonPropertyName("gscVersion")
    @JsonPropertyOrder(int32(3))
    prop GscVersion string?

    /// Gets or sets the corpus app id (e.g. `corpus/L2-Library`).
    @JsonPropertyName("corpusAppId")
    @JsonPropertyOrder(int32(4))
    prop CorpusAppId string

    /// Gets or sets the stage that failed (`translate`/`compile`/…).
    @JsonPropertyName("stage")
    @JsonPropertyOrder(int32(5))
    prop Stage string

    /// Gets or sets the triage category.
    @JsonPropertyName("category")
    @JsonPropertyOrder(int32(6))
    prop Category string

    /// Gets or sets the diagnostic id/message/severity.
    @JsonPropertyName("diagnostic")
    @JsonPropertyOrder(int32(7))
    prop Diagnostic TriageDiagnostic?

    /// Gets or sets the emitted-G# and originating-C# source locations.
    @JsonPropertyName("sourceLocation")
    @JsonPropertyOrder(int32(8))
    prop SourceLocation TriageSourceLocation

    /// Gets or sets the offending C# construct kind plus a minimal snippet.
    @JsonPropertyName("offendingCSharpConstruct")
    @JsonPropertyOrder(int32(9))
    prop OffendingCSharpConstruct TriageOffendingConstruct?

    /// Gets or sets the pre-rendered, ready-to-file issue.
    @JsonPropertyName("suggestedIssue")
    @JsonPropertyOrder(int32(10))
    prop SuggestedIssue TriageSuggestedIssue?

    /// Gets or sets the dedup fingerprint (ADR-0115 §D.2).
    @JsonPropertyName("fingerprint")
    @JsonPropertyOrder(int32(11))
    prop Fingerprint string

    /// Gets or sets the prior `{runId, gscVersion, result}` records for this fingerprint.
    private var _retryHistory List[TriageRetryEntry] = List[TriageRetryEntry]()

    @JsonPropertyName("retryHistory")
    @JsonPropertyOrder(int32(12))
    prop RetryHistory List[TriageRetryEntry] {
        get {
            return _retryHistory
        }
        set {
            _retryHistory = value
        }
    }
}

/// The G# diagnostic id/message/severity carried by a triage artifact
/// (ADR-0115 §D.1).
class TriageDiagnostic {
    /// Gets or sets the diagnostic id (e.g. `GS0313`).
    @JsonPropertyName("id")
    @JsonPropertyOrder(int32(0))
    prop Id string?

    /// Gets or sets the diagnostic message.
    @JsonPropertyName("message")
    @JsonPropertyOrder(int32(1))
    prop Message string

    /// Gets or sets the diagnostic severity (e.g. `error`).
    @JsonPropertyName("severity")
    @JsonPropertyOrder(int32(2))
    prop Severity string
}

/// Both ends of the C#↔G# source map for a failure: the emitted-`.gs`
/// position and the originating C# position. Sub-fields are
/// `null` when a precise mapping is not available — see
/// (cref:MigrationPipeline) for the documented null rules (ADR-0115 §D.1).
class TriageSourceLocation {
    /// Gets or sets the emitted G# file (relative to the run dir), or null.
    @JsonPropertyName("gsFile")
    @JsonPropertyOrder(int32(0))
    prop GsFile string?

    /// Gets or sets the 1-based G# line, or null.
    @JsonPropertyName("gsLine")
    @JsonPropertyOrder(int32(1))
    prop GsLine int32?

    /// Gets or sets the 1-based G# column, or null.
    @JsonPropertyName("gsColumn")
    @JsonPropertyOrder(int32(2))
    prop GsColumn int32?

    /// Gets or sets the originating C# file, or null.
    @JsonPropertyName("csFile")
    @JsonPropertyOrder(int32(3))
    prop CsFile string?

    /// Gets or sets the 1-based C# line, or null.
    @JsonPropertyName("csLine")
    @JsonPropertyOrder(int32(4))
    prop CsLine int32?

    /// Gets or sets the 1-based C# column, or null.
    @JsonPropertyName("csColumn")
    @JsonPropertyOrder(int32(5))
    prop CsColumn int32?
}

/// The offending construct kind plus a minimal snippet (ADR-0115 §D.1). For
/// stage 1 this is the C# construct; for stage 2 — where no precise C# map
/// exists — it is the emitted G# construct that `gsc` flagged.
class TriageOffendingConstruct {
    /// Gets or sets the construct kind (e.g. `RecordDeclaration`).
    @JsonPropertyName("kind")
    @JsonPropertyOrder(int32(0))
    prop Kind string?

    /// Gets or sets a minimal one-line snippet of the construct.
    @JsonPropertyName("snippet")
    @JsonPropertyOrder(int32(1))
    prop Snippet string?
}

/// A pre-rendered, human-fileable issue the external agent can file as-is
/// (ADR-0115 §D.1). The `labels` list always contains `Oats`.
class TriageSuggestedIssue {
    /// Gets or sets the issue title.
    @JsonPropertyName("title")
    @JsonPropertyOrder(int32(0))
    prop Title string

    /// Gets or sets the issue body.
    @JsonPropertyName("body")
    @JsonPropertyOrder(int32(1))
    prop Body string

    /// Gets or sets the issue labels (always includes `Oats`).
    private var _labels List[string] = List[string]()

    @JsonPropertyName("labels")
    @JsonPropertyOrder(int32(2))
    prop Labels List[string] {
        get {
            return _labels
        }
        set {
            _labels = value
        }
    }
}

/// One prior-run record in a fingerprint's `retryHistory` (ADR-0115 §D.1).
class TriageRetryEntry {
    /// Gets or sets the prior run id.
    @JsonPropertyName("runId")
    @JsonPropertyOrder(int32(0))
    prop RunId string

    /// Gets or sets the prior `gsc` version.
    @JsonPropertyName("gscVersion")
    @JsonPropertyOrder(int32(1))
    prop GscVersion string?

    /// Gets or sets the prior result (`fail` or `pass`).
    @JsonPropertyName("result")
    @JsonPropertyOrder(int32(2))
    prop Result string
}
