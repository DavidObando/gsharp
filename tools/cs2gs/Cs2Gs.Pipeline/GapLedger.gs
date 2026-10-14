// <copyright file="GapLedger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.Json
import System.Text.Json.Serialization

/// The checked-in gap ledger (`tools/cs2gs/triage/gaps.json`, ADR-0138):
/// one artifact serving two consumers — the fingerprint↔issue map for the
/// automated filing workflow, and the CI baseline for `cs2gs migrate
/// --baseline`. `open`/`wontfix`/`superseded` entries are the
/// allowlist; `resolved` entries are regression tripwires. Every mutation
/// goes through a PR (or the nightly automation's PR).
class GapLedger {
    /// Initializes a new instance of the (cref:GapLedger) class.
    /// @param entries The ledger rows.
    init(entries List[GapLedgerEntry]) {
        this.Entries = entries ?? throw ArgumentNullException("entries")
    }

    /// Gets or sets the schema version.
    private var _schemaVersion string? = "1.0"

    @JsonPropertyName("schemaVersion")
    prop SchemaVersion string? {
        get {
            return _schemaVersion
        }
        set {
            _schemaVersion = value
        }
    }

    /// Gets or sets the corpus apps acknowledged as not-fully-verified (a
    /// stage skipped without a triage artifact — e.g. a library whose xUnit
    /// parity path is gated). A skip produces no fingerprint, so without this
    /// acknowledgement an unverified app would render green at the gate — the
    /// issue #1831 failure class.
    private var _unverifiedApps List[string]? = List[string]()

    @JsonPropertyName("unverifiedApps")
    prop UnverifiedApps List[string]? {
        get {
            return _unverifiedApps
        }
        set {
            _unverifiedApps = value
        }
    }

    /// Gets the ledger rows.
    @JsonPropertyName("gaps")
    prop Entries List[GapLedgerEntry] {
        get;
    }

    /// Serializes the ledger (entries sorted by fingerprint) to canonical JSON text.
    /// @returns The JSON text, LF line endings, trailing newline.
    func ToJson() string {
        let envelope = GapLedgerEnvelope{
            SchemaVersion: this.SchemaVersion,
            UnverifiedApps: this.UnverifiedApps!!.OrderBy((a string) -> a, StringComparer.Ordinal).ToList(),
            Gaps: this.Entries.OrderBy((e GapLedgerEntry) -> e.Fingerprint, StringComparer.Ordinal).ToList()
        }
        return JsonSerializer.Serialize(envelope, SerializerOptions).Replace("\r\n", "\n") + "\n"
    }

    /// Saves the ledger canonically.
    /// @param path The ledger file path.
    func Save(path string) {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!!)
        File.WriteAllText(path, this.ToJson())
    }

    /// Classifies a run's triage artifacts against the ledger (ADR-0138 gate
    /// semantics): NEW (unledgered — fails CI), KNOWN (open/wontfix/superseded
    /// — tolerated), REGRESSED (resolved but reproduced — fails CI), STALE
    /// (open entries not reproduced — meaningful only for full-corpus runs;
    /// warns on the PR gate, fails the strict nightly).
    /// @param artifacts The run's triage artifacts.
    /// @param fullCorpus Whether the run covered the full corpus (enables STALE detection).
    /// @returns The classification.
    func Classify(artifacts IReadOnlyList[TriageArtifact], fullCorpus bool) BaselineClassification {
        let byFingerprint = Dictionary[string, GapLedgerEntry](StringComparer.Ordinal)
        for entry in this.Entries {
            byFingerprint[entry.Fingerprint] = entry
        }
        let result = BaselineClassification()
        let seen = HashSet[string](StringComparer.Ordinal)
        for artifact in artifacts {
            if !seen.Add(artifact.Fingerprint) {
                continue
            }
            if !byFingerprint.TryGetValue(artifact.Fingerprint, out var entry) {
                result.New.Add(artifact)
            } else if string.Equals(entry.Status, GapLedgerEntry.StatusResolved, StringComparison.Ordinal) {
                result.Regressed.Add(artifact)
            } else {
                result.Known.Add(artifact)
            }
        }
        if fullCorpus {
            result.Stale.AddRange(
                this.Entries.Where(
                    (e GapLedgerEntry) -> string.Equals(
                        e.Status,
                        GapLedgerEntry.StatusOpen,
                        StringComparison.Ordinal
                    ) &&
                        !seen.Contains(e.Fingerprint)
                )
            )
        }
        return result
    }

    shared {
        /// The repo-relative path of the ledger file.
        const RepoRelativePath string = "tools/cs2gs/triage/gaps.json"

        private let SerializerOptions JsonSerializerOptions = JsonSerializerOptions{
            WriteIndented: true,
            DefaultIgnoreCondition: JsonIgnoreCondition.WhenWritingNull
        }

        /// Loads the ledger from a JSON file; a missing file is an empty ledger.
        /// @param path The ledger file path.
        /// @returns The loaded ledger.
        func Load(path string) GapLedger {
            if !File.Exists(path) {
                return GapLedger(List[GapLedgerEntry]())
            }
            using let doc = JsonDocument.Parse(File.ReadAllText(path))
            let entries List[GapLedgerEntry]? = if doc.RootElement.TryGetProperty("gaps", out var gaps) {
                JsonSerializer.Deserialize[List[GapLedgerEntry]](gaps.GetRawText(), SerializerOptions)
            } else {
                List[GapLedgerEntry]()
            }
            let ledger = GapLedger(entries ?? List[GapLedgerEntry]())
            if doc.RootElement.TryGetProperty("schemaVersion", out var version) {
                ledger.SchemaVersion = version.GetString()
            }
            if doc.RootElement.TryGetProperty("unverifiedApps", out var unverified) {
                ledger.UnverifiedApps = JsonSerializer.Deserialize[List[string]](
                    unverified.GetRawText(),
                    SerializerOptions
                )
            }
            return ledger
        }

        /// Loads every triage artifact of a run directory (the writer's layout:
        /// `<runDir>/<appDir>/<stage>-<hash>.json`, top-level app
        /// files only — never build scaffolds; see issue #1751).
        /// @param runDir The run directory containing `run.json`.
        /// @returns The parsed artifacts.
        func LoadRunArtifacts(runDir string) IReadOnlyList[TriageArtifact] {
            let artifacts = List[TriageArtifact]()
            for appDir in Directory.EnumerateDirectories(runDir) {
                for file in Directory.EnumerateFiles(appDir, "*.json", SearchOption.TopDirectoryOnly) {
                    try {
                        let artifact TriageArtifact? = JsonSerializer.Deserialize[TriageArtifact](
                            File.ReadAllText(file),
                            TriageSerialization.Options
                        )
                        if artifact?.Fingerprint != nil {
                            artifacts.Add(artifact!!)
                        }
                    } catch (JsonException) { } catch (IOException) { }
                }
            }
            return artifacts
        }
    }
}

/// One gap-ledger row: a triage fingerprint and its filed-issue disposition.
class GapLedgerEntry {
    /// Gets or sets the triage fingerprint (`sha256:…`).
    @JsonPropertyName("fingerprint")
    @JsonPropertyOrder(int32(0))
    prop Fingerprint string

    /// Gets or sets the GitHub issue number.
    @JsonPropertyName("issue")
    @JsonPropertyOrder(int32(1))
    prop Issue int32?

    /// Gets or sets the status: open | resolved | wontfix | superseded.
    @JsonPropertyName("status")
    @JsonPropertyOrder(int32(2))
    prop Status string

    /// Gets or sets the filed issue title (human orientation only).
    @JsonPropertyName("title")
    @JsonPropertyOrder(int32(3))
    prop Title string

    /// Gets or sets the failing stage (`translate`/`compile`/`ilverify`/`test-parity`).
    @JsonPropertyName("stage")
    @JsonPropertyOrder(int32(4))
    prop Stage string

    /// Gets or sets the diagnostic id (e.g. `GS0157`, `CS2GS-GAP`).
    @JsonPropertyName("diagnosticId")
    @JsonPropertyOrder(int32(5))
    prop DiagnosticId string?

    /// Gets or sets the offending C# construct kind.
    @JsonPropertyName("constructKind")
    @JsonPropertyOrder(int32(6))
    prop ConstructKind string?

    /// Gets or sets the run id where the fingerprint first appeared.
    @JsonPropertyName("firstSeenRun")
    @JsonPropertyOrder(int32(7))
    prop FirstSeenRun string

    /// Gets or sets the corpus apps that surfaced the gap.
    @JsonPropertyName("apps")
    @JsonPropertyOrder(int32(8))
    prop Apps List[string]

    /// Gets or sets the fingerprint this entry was folded into (status `superseded`).
    @JsonPropertyName("supersededBy")
    @JsonPropertyOrder(int32(9))
    prop SupersededBy string?

    /// Gets or sets free-form human notes.
    @JsonPropertyName("notes")
    @JsonPropertyOrder(int32(10))
    prop Notes string

    shared {
        /// The status of a gap whose issue is still open.
        const StatusOpen string = "open"

        /// The status of a gap whose issue was fixed (a reappearance is a regression).
        const StatusResolved string = "resolved"

        /// The status of a gap deliberately not being fixed.
        const StatusWontfix string = "wontfix"

        /// The status of a fingerprint folded into another entry's issue.
        const StatusSuperseded string = "superseded"
    }
}

/// The result of classifying a run's fingerprints against the ledger.
class BaselineClassification {
    init() {
        New = List[TriageArtifact]()
        Known = List[TriageArtifact]()
        Regressed = List[TriageArtifact]()
        Stale = List[GapLedgerEntry]()
    }

    /// Gets the unledgered artifacts (one per distinct fingerprint) — fail CI, feed automated filing.
    prop New List[TriageArtifact] {
        get;
    }

    /// Gets the artifacts matching open/wontfix/superseded entries — tolerated.
    prop Known List[TriageArtifact] {
        get;
    }

    /// Gets the artifacts matching resolved entries — regressions, fail CI.
    prop Regressed List[TriageArtifact] {
        get;
    }

    /// Gets the open ledger entries not reproduced by a full-corpus run.
    prop Stale List[GapLedgerEntry] {
        get;
    }

    /// Gets a value indicating whether the run passes the baseline gate (no NEW, no REGRESSED).
    prop PassesGate bool -> this.New.Count == 0 && this.Regressed.Count == 0
}

/// The serialized shape of the ledger file.
internal class GapLedgerEnvelope {
    /// Gets or sets the schema version.
    @JsonPropertyName("schemaVersion")
    @JsonPropertyOrder(int32(0))
    prop SchemaVersion string?

    /// Gets or sets the acknowledged not-fully-verified corpus apps.
    @JsonPropertyName("unverifiedApps")
    @JsonPropertyOrder(int32(1))
    prop UnverifiedApps List[string]

    /// Gets or sets the gap rows.
    @JsonPropertyName("gaps")
    @JsonPropertyOrder(int32(2))
    prop Gaps List[GapLedgerEntry]
}
