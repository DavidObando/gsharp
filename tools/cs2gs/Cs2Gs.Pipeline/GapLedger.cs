// <copyright file="GapLedger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The checked-in gap ledger (<c>tools/cs2gs/triage/gaps.json</c>, ADR-0138):
/// one artifact serving two consumers — the fingerprint↔issue map for the
/// automated filing workflow, and the CI baseline for <c>cs2gs migrate
/// --baseline</c>. <c>open</c>/<c>wontfix</c>/<c>superseded</c> entries are the
/// allowlist; <c>resolved</c> entries are regression tripwires. Every mutation
/// goes through a PR (or the nightly automation's PR).
/// </summary>
public sealed class GapLedger
{
    /// <summary>The repo-relative path of the ledger file.</summary>
    public const string RepoRelativePath = "tools/cs2gs/triage/gaps.json";

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// Initializes a new instance of the <see cref="GapLedger"/> class.
    /// </summary>
    /// <param name="entries">The ledger rows.</param>
    public GapLedger(List<GapLedgerEntry> entries)
    {
        this.Entries = entries ?? throw new ArgumentNullException(nameof(entries));
    }

    /// <summary>Gets or sets the schema version.</summary>
    [JsonPropertyName("schemaVersion")]
    public string SchemaVersion { get; set; } = "1.0";

    /// <summary>
    /// Gets or sets the corpus apps acknowledged as not-fully-verified (a
    /// stage skipped without a triage artifact — e.g. a library whose xUnit
    /// parity path is gated). A skip produces no fingerprint, so without this
    /// acknowledgement an unverified app would render green at the gate — the
    /// issue #1831 failure class.
    /// </summary>
    [JsonPropertyName("unverifiedApps")]
    public List<string> UnverifiedApps { get; set; } = new List<string>();

    /// <summary>Gets the ledger rows.</summary>
    [JsonPropertyName("gaps")]
    public List<GapLedgerEntry> Entries { get; }

    /// <summary>
    /// Loads the ledger from a JSON file; a missing file is an empty ledger.
    /// </summary>
    /// <param name="path">The ledger file path.</param>
    /// <returns>The loaded ledger.</returns>
    public static GapLedger Load(string path)
    {
        if (!File.Exists(path))
        {
            return new GapLedger(new List<GapLedgerEntry>());
        }

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        List<GapLedgerEntry> entries = doc.RootElement.TryGetProperty("gaps", out JsonElement gaps)
            ? JsonSerializer.Deserialize<List<GapLedgerEntry>>(gaps.GetRawText(), SerializerOptions)
            : new List<GapLedgerEntry>();
        var ledger = new GapLedger(entries ?? new List<GapLedgerEntry>());
        if (doc.RootElement.TryGetProperty("schemaVersion", out JsonElement version))
        {
            ledger.SchemaVersion = version.GetString();
        }

        if (doc.RootElement.TryGetProperty("unverifiedApps", out JsonElement unverified))
        {
            ledger.UnverifiedApps = JsonSerializer.Deserialize<List<string>>(unverified.GetRawText(), SerializerOptions);
        }

        return ledger;
    }

    /// <summary>
    /// Loads every triage artifact of a run directory (the writer's layout:
    /// <c><![CDATA[<runDir>/<appDir>/<stage>-<hash>.json]]></c>, top-level app
    /// files only — never build scaffolds; see issue #1751).
    /// </summary>
    /// <param name="runDir">The run directory containing <c>run.json</c>.</param>
    /// <returns>The parsed artifacts.</returns>
    public static IReadOnlyList<TriageArtifact> LoadRunArtifacts(string runDir)
    {
        var artifacts = new List<TriageArtifact>();
        foreach (string appDir in Directory.EnumerateDirectories(runDir))
        {
            foreach (string file in Directory.EnumerateFiles(appDir, "*.json", SearchOption.TopDirectoryOnly))
            {
                try
                {
                    TriageArtifact artifact = JsonSerializer.Deserialize<TriageArtifact>(
                        File.ReadAllText(file), TriageSerialization.Options);
                    if (artifact?.Fingerprint is not null)
                    {
                        artifacts.Add(artifact);
                    }
                }
                catch (JsonException)
                {
                }
                catch (IOException)
                {
                }
            }
        }

        return artifacts;
    }

    /// <summary>
    /// Serializes the ledger (entries sorted by fingerprint) to canonical JSON text.
    /// </summary>
    /// <returns>The JSON text, LF line endings, trailing newline.</returns>
    public string ToJson()
    {
        var envelope = new GapLedgerEnvelope
        {
            SchemaVersion = this.SchemaVersion,
            UnverifiedApps = this.UnverifiedApps.OrderBy(a => a, StringComparer.Ordinal).ToList(),
            Gaps = this.Entries.OrderBy(e => e.Fingerprint, StringComparer.Ordinal).ToList(),
        };
        return JsonSerializer.Serialize(envelope, SerializerOptions).Replace("\r\n", "\n") + "\n";
    }

    /// <summary>
    /// Saves the ledger canonically.
    /// </summary>
    /// <param name="path">The ledger file path.</param>
    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, this.ToJson());
    }

    /// <summary>
    /// Classifies a run's triage artifacts against the ledger (ADR-0138 gate
    /// semantics): NEW (unledgered — fails CI), KNOWN (open/wontfix/superseded
    /// — tolerated), REGRESSED (resolved but reproduced — fails CI), STALE
    /// (open entries not reproduced — meaningful only for full-corpus runs;
    /// warns on the PR gate, fails the strict nightly).
    /// </summary>
    /// <param name="artifacts">The run's triage artifacts.</param>
    /// <param name="fullCorpus">Whether the run covered the full corpus (enables STALE detection).</param>
    /// <returns>The classification.</returns>
    public BaselineClassification Classify(IReadOnlyList<TriageArtifact> artifacts, bool fullCorpus)
    {
        var byFingerprint = new Dictionary<string, GapLedgerEntry>(StringComparer.Ordinal);
        foreach (GapLedgerEntry entry in this.Entries)
        {
            byFingerprint[entry.Fingerprint] = entry;
        }

        var result = new BaselineClassification();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (TriageArtifact artifact in artifacts)
        {
            if (!seen.Add(artifact.Fingerprint))
            {
                continue;
            }

            if (!byFingerprint.TryGetValue(artifact.Fingerprint, out GapLedgerEntry entry))
            {
                result.New.Add(artifact);
            }
            else if (string.Equals(entry.Status, GapLedgerEntry.StatusResolved, StringComparison.Ordinal))
            {
                result.Regressed.Add(artifact);
            }
            else
            {
                result.Known.Add(artifact);
            }
        }

        if (fullCorpus)
        {
            result.Stale.AddRange(this.Entries.Where(e =>
                string.Equals(e.Status, GapLedgerEntry.StatusOpen, StringComparison.Ordinal)
                && !seen.Contains(e.Fingerprint)));
        }

        return result;
    }
}

/// <summary>
/// One gap-ledger row: a triage fingerprint and its filed-issue disposition.
/// </summary>
public sealed class GapLedgerEntry
{
    /// <summary>The status of a gap whose issue is still open.</summary>
    public const string StatusOpen = "open";

    /// <summary>The status of a gap whose issue was fixed (a reappearance is a regression).</summary>
    public const string StatusResolved = "resolved";

    /// <summary>The status of a gap deliberately not being fixed.</summary>
    public const string StatusWontfix = "wontfix";

    /// <summary>The status of a fingerprint folded into another entry's issue.</summary>
    public const string StatusSuperseded = "superseded";

    /// <summary>Gets or sets the triage fingerprint (<c>sha256:…</c>).</summary>
    [JsonPropertyName("fingerprint")]
    [JsonPropertyOrder(0)]
    public string Fingerprint { get; set; }

    /// <summary>Gets or sets the GitHub issue number.</summary>
    [JsonPropertyName("issue")]
    [JsonPropertyOrder(1)]
    public int? Issue { get; set; }

    /// <summary>Gets or sets the status: open | resolved | wontfix | superseded.</summary>
    [JsonPropertyName("status")]
    [JsonPropertyOrder(2)]
    public string Status { get; set; }

    /// <summary>Gets or sets the filed issue title (human orientation only).</summary>
    [JsonPropertyName("title")]
    [JsonPropertyOrder(3)]
    public string Title { get; set; }

    /// <summary>Gets or sets the failing stage (<c>translate</c>/<c>compile</c>/<c>ilverify</c>/<c>test-parity</c>).</summary>
    [JsonPropertyName("stage")]
    [JsonPropertyOrder(4)]
    public string Stage { get; set; }

    /// <summary>Gets or sets the diagnostic id (e.g. <c>GS0157</c>, <c>CS2GS-GAP</c>).</summary>
    [JsonPropertyName("diagnosticId")]
    [JsonPropertyOrder(5)]
    public string DiagnosticId { get; set; }

    /// <summary>Gets or sets the offending C# construct kind.</summary>
    [JsonPropertyName("constructKind")]
    [JsonPropertyOrder(6)]
    public string ConstructKind { get; set; }

    /// <summary>Gets or sets the run id where the fingerprint first appeared.</summary>
    [JsonPropertyName("firstSeenRun")]
    [JsonPropertyOrder(7)]
    public string FirstSeenRun { get; set; }

    /// <summary>Gets or sets the corpus apps that surfaced the gap.</summary>
    [JsonPropertyName("apps")]
    [JsonPropertyOrder(8)]
    public List<string> Apps { get; set; }

    /// <summary>Gets or sets the fingerprint this entry was folded into (status <c>superseded</c>).</summary>
    [JsonPropertyName("supersededBy")]
    [JsonPropertyOrder(9)]
    public string SupersededBy { get; set; }

    /// <summary>Gets or sets free-form human notes.</summary>
    [JsonPropertyName("notes")]
    [JsonPropertyOrder(10)]
    public string Notes { get; set; }
}

/// <summary>
/// The result of classifying a run's fingerprints against the ledger.
/// </summary>
public sealed class BaselineClassification
{
    /// <summary>Gets the unledgered artifacts (one per distinct fingerprint) — fail CI, feed automated filing.</summary>
    public List<TriageArtifact> New { get; } = new List<TriageArtifact>();

    /// <summary>Gets the artifacts matching open/wontfix/superseded entries — tolerated.</summary>
    public List<TriageArtifact> Known { get; } = new List<TriageArtifact>();

    /// <summary>Gets the artifacts matching resolved entries — regressions, fail CI.</summary>
    public List<TriageArtifact> Regressed { get; } = new List<TriageArtifact>();

    /// <summary>Gets the open ledger entries not reproduced by a full-corpus run.</summary>
    public List<GapLedgerEntry> Stale { get; } = new List<GapLedgerEntry>();

    /// <summary>Gets a value indicating whether the run passes the baseline gate (no NEW, no REGRESSED).</summary>
    public bool PassesGate => this.New.Count == 0 && this.Regressed.Count == 0;
}

/// <summary>
/// The serialized shape of the ledger file.
/// </summary>
internal sealed class GapLedgerEnvelope
{
    /// <summary>Gets or sets the schema version.</summary>
    [JsonPropertyName("schemaVersion")]
    [JsonPropertyOrder(0)]
    public string SchemaVersion { get; set; }

    /// <summary>Gets or sets the acknowledged not-fully-verified corpus apps.</summary>
    [JsonPropertyName("unverifiedApps")]
    [JsonPropertyOrder(1)]
    public List<string> UnverifiedApps { get; set; }

    /// <summary>Gets or sets the gap rows.</summary>
    [JsonPropertyName("gaps")]
    [JsonPropertyOrder(2)]
    public List<GapLedgerEntry> Gaps { get; set; }
}
