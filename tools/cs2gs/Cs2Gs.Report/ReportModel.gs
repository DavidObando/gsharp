// <copyright file="ReportModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Report

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.Json
import System.Text.Json.Serialization

/// The aggregated, render-ready view of one completed migration run (ADR-0115
/// §F): run-level provenance, the per-app × per-stage status matrix (stages in
/// execution order, including `skipped`), and the discovered-gap list
/// grouped by `fingerprint` (§D.2) with per-app occurrences and a merged
/// `retryHistory`. Built once from a run directory's `run.json` plus
/// the referenced triage artifacts (§D.1) and consumed by both
/// (cref:JsonSummaryWriter) and (cref:HtmlReportWriter).
class ReportModel {
    /// Gets or sets the run id.
    @JsonPropertyName("runId")
    @JsonPropertyOrder(int32(0))
    prop RunId string

    /// Gets or sets the ISO-8601 UTC run timestamp.
    @JsonPropertyName("timestamp")
    @JsonPropertyOrder(int32(1))
    prop Timestamp string

    /// Gets or sets the compiler version the run executed against.
    @JsonPropertyName("gscVersion")
    @JsonPropertyOrder(int32(2))
    prop GscVersion string

    /// Gets or sets a value indicating whether every app passed every stage.
    @JsonPropertyName("succeeded")
    @JsonPropertyOrder(int32(3))
    prop Succeeded bool

    /// Gets or sets a value indicating whether no app failed but at least one
    /// app is unverified (a genuinely-unavailable dependency for one of its
    /// stages). Mirrors (cref:RunResult.Unverified); kept distinct from
    /// (cref:Succeeded) so the run headline cannot render "not
    /// verified" as verified-green (issue #1831).
    @JsonPropertyName("unverified")
    @JsonPropertyOrder(int32(4))
    prop Unverified bool

    /// Gets or sets the total number of apps in the run.
    @JsonPropertyName("totalApps")
    @JsonPropertyOrder(int32(5))
    prop TotalApps int32

    /// Gets or sets the number of apps green across every stage.
    @JsonPropertyName("greenApps")
    @JsonPropertyOrder(int32(6))
    prop GreenApps int32

    /// Gets or sets the number of apps that did not fail but have at least one
    /// unverified stage. Counted separately from (cref:GreenApps) —
    /// never both (issue #1831).
    @JsonPropertyName("unverifiedApps")
    @JsonPropertyOrder(int32(7))
    prop UnverifiedApps int32

    /// Gets or sets the stage names in execution order (Translate→Compile→IlVerify→TestParity).
    private var _stageOrder List[string] = List[string]()

    @JsonPropertyName("stageOrder")
    @JsonPropertyOrder(int32(8))
    prop StageOrder List[string] {
        get {
            return _stageOrder
        }
        set {
            _stageOrder = value
        }
    }

    /// Gets or sets the per-app results, sorted by app id, each with its stages in execution order.
    private var _apps List[AppReport] = List[AppReport]()

    @JsonPropertyName("apps")
    @JsonPropertyOrder(int32(9))
    prop Apps List[AppReport] {
        get {
            return _apps
        }
        set {
            _apps = value
        }
    }

    /// Gets or sets the discovered gaps, grouped by fingerprint and sorted by fingerprint.
    private var _gaps List[GapReport] = List[GapReport]()

    @JsonPropertyName("gaps")
    @JsonPropertyOrder(int32(10))
    prop Gaps List[GapReport] {
        get {
            return _gaps
        }
        set {
            _gaps = value
        }
    }

    /// Gets or sets the number of triage artifact paths referenced by `run.json`
    /// that could not be found on disk when the model was built. A run whose apps
    /// reference artifacts that are missing (deleted, not yet copied, or a
    /// truncated/partial run) has incomplete gap data even when
    /// (cref:Gaps) ends up empty; consumers must not read an empty
    /// (cref:Gaps) list as "no gaps" unless this is also zero. See
    /// (cref:IsGreen).
    @JsonPropertyName("missingArtifactCount")
    @JsonPropertyOrder(int32(11))
    prop MissingArtifactCount int32

    /// Gets a value indicating whether the run is genuinely green: it must be
    /// based on positive evidence — the run itself reported success
    /// ((cref:Succeeded)) with nothing left unverified
    /// ((cref:Unverified) is `false`), every referenced
    /// triage artifact was readable ((cref:MissingArtifactCount) is
    /// zero), and no gaps were discovered ((cref:Gaps) is empty) —
    /// never on the mere absence of gap data, which can also mean the triage
    /// artifacts were missing or the run failed outright.
    @JsonPropertyName("isGreen")
    @JsonPropertyOrder(int32(12))
    prop IsGreen bool -> this.Succeeded && !this.Unverified && this.MissingArtifactCount == 0 && this.Gaps.Count == 0

    /// Gets or sets the absolute run directory the model was built from (i.e.
    /// the directory (cref:AppReport.Artifacts) paths are relative to).
    /// Not part of the `summary.json` schema; used only so
    /// (cref:HtmlReportWriter) can re-resolve artifact links when
    /// `report.html` is written somewhere other than the run dir.
    @JsonIgnore
    prop RunDir string

    shared {
        /// Builds a (cref:ReportModel) from a run directory by reading its
        /// `run.json` and every referenced triage artifact.
        /// @param runDir The run directory (contains `run.json`).
        /// @returns The aggregated model.
        func FromRunDirectory(runDir string) ReportModel {
            if string.IsNullOrEmpty(runDir) {
                throw ArgumentException("Run directory is required.", "runDir")
            }
            let runJsonPath = Path.Combine(runDir, "run.json")
            if !File.Exists(runJsonPath) {
                throw FileNotFoundException("run.json not found in run directory.", runJsonPath)
            }
            let run RunResult? = JsonSerializer.Deserialize[RunResult](
                File.ReadAllText(runJsonPath),
                TriageSerialization.Options
            )
            if run == nil {
                throw InvalidDataException("run.json at '$runJsonPath' did not deserialize.")
            }
            return Build(run, runDir)
        }

        /// Builds a (cref:ReportModel) from an in-memory (cref:RunResult),
        /// loading the referenced triage artifacts relative to [`runDir`](paramref).
        /// @param run The deserialized run summary.
        /// @param runDir The run directory used to resolve artifact paths.
        /// @returns The aggregated model.
        func Build(run RunResult?, runDir string) ReportModel {
            if run == nil {
                throw ArgumentNullException("run")
            }
            let stageOrder = CanonicalStageOrder()
            let apps = List[AppReport]()
            let artifacts = List[(AppId string, Artifact TriageArtifact?)]()
            var missingArtifactCount = 0
            for app in run.Apps.OrderBy((a AppResult) -> a.AppId, StringComparer.Ordinal) {
                apps.Add(BuildAppReport(app, stageOrder))
                for relative in app.Artifacts ?? List[string]() {
                    let artifactPath = Path.Combine(runDir, relative.Replace('/', Path.DirectorySeparatorChar))
                    if !File.Exists(artifactPath) {
                        missingArtifactCount++
                        Console.Error.WriteLine(
                            "cs2gs: warning: triage artifact '$relative' referenced by app '${app.AppId}' is missing under $runDir; gap data is incomplete."
                        )
                        continue
                    }
                    var artifact TriageArtifact?
                    try {
                        artifact = JsonSerializer.Deserialize[TriageArtifact](
                            File.ReadAllText(artifactPath),
                            TriageSerialization.Options
                        )
                    } catch (JsonException) {
                        missingArtifactCount++
                        Console.Error.WriteLine(
                            "cs2gs: warning: triage artifact '$relative' referenced by app '${app.AppId}' is malformed; gap data is incomplete."
                        )
                        continue
                    }
                    if artifact == nil {
                        missingArtifactCount++
                        Console.Error.WriteLine(
                            "cs2gs: warning: triage artifact '$relative' referenced by app '${app.AppId}' did not deserialize; gap data is incomplete."
                        )
                        continue
                    }
                    artifacts.Add((app.AppId, artifact))
                }
            }
            // A green app must be verified: succeeded AND not merely skipped
            // (issue #1831). Unverified apps get their own bucket, never green's.
            let greenApps = run.Apps.Count((a AppResult) -> a.Succeeded && !a.Unverified)
            let unverifiedApps = run.Apps.Count((a AppResult) -> a.Unverified)
            return ReportModel{
                RunId: run.RunId,
                Timestamp: run.Timestamp,
                GscVersion: run.GscVersion!!,
                Succeeded: run.Succeeded,
                Unverified: run.Unverified,
                TotalApps: run.Apps.Count,
                GreenApps: greenApps,
                UnverifiedApps: unverifiedApps,
                StageOrder: stageOrder,
                Apps: apps,
                Gaps: GroupGaps(artifacts),
                MissingArtifactCount: missingArtifactCount,
                RunDir: Path.GetFullPath(runDir)
            }
        }

        private func CanonicalStageOrder() List[string] {
            return Enum.GetValues[MigrationStageKind]().Select(TriageSerialization.StageName).ToList()
        }

        private func BuildAppReport(app AppResult, stageOrder List[string]) AppReport {
            let byName = (app.Stages ?? List[StageResult]())
                .Where((s StageResult) -> s.Stage != nil)
                .GroupBy((s StageResult) -> s.Stage, StringComparer.Ordinal)
                .ToDictionary(
                func (g IGrouping[string, StageResult]) string {
                    return g.Key
                },
                (g IGrouping[string, StageResult]) -> g.First(),
                StringComparer.Ordinal
            )
            let stages = List[StageResult]()
            for stageName in stageOrder {
                if byName.TryGetValue(stageName, out var stage) {
                    stages.Add(
                        StageResult{
                            Stage: stageName,
                            Status: stage.Status ?? "skipped",
                            ArtifactCount: stage.ArtifactCount
                        }
                    )
                } else {
                    stages.Add(StageResult{Stage: stageName, Status: "skipped", ArtifactCount: 0})
                }
            }
            return AppReport{
                AppId: app.AppId,
                Succeeded: app.Succeeded,
                Unverified: app.Unverified,
                FailureCategory: app.FailureCategory,
                Stages: stages,
                Artifacts: (app.Artifacts ?? List[string]()).OrderBy((a string) -> a, StringComparer.Ordinal).ToList(),
                Fingerprints: (app.Fingerprints ?? List[string]()).OrderBy((f string) -> f, StringComparer.Ordinal)
                    .ToList()
            }
        }

        private func GroupGaps(artifacts List[(AppId string, Artifact TriageArtifact?)]) List[GapReport] {
            let gaps = List[GapReport]()
            for group in artifacts.GroupBy(
                (a(AppId string, Artifact TriageArtifact)) -> a.Artifact.Fingerprint,
                StringComparer.Ordinal
            )
                .OrderBy(
                (g IGrouping[string, (AppId string, Artifact TriageArtifact)]) -> g.Key,
                StringComparer.Ordinal
            ) {
                // Choose a deterministic representative: the lowest app id, then artifact.
                let ordered = group
                    .OrderBy((a(AppId string, Artifact TriageArtifact)) -> a.AppId, StringComparer.Ordinal)
                    .ThenBy(
                    (a(AppId string, Artifact TriageArtifact)) -> a.Artifact.CorpusAppId,
                    StringComparer.Ordinal
                )
                    .ToList()
                let head = ordered[0].Artifact
                let occurrences = ordered
                    .Select(
                    (a(AppId string, Artifact TriageArtifact)) -> GapOccurrence{
                        AppId: a.AppId,
                        SourceLocation: a.Artifact.SourceLocation
                    }
                )
                    .OrderBy((o GapOccurrence) -> o.AppId, StringComparer.Ordinal)
                    .ToList()
                gaps.Add(
                    GapReport{
                        Fingerprint: group.Key,
                        Category: head.Category,
                        Stage: head.Stage,
                        Diagnostic: head.Diagnostic!!,
                        OffendingCSharpConstruct: head.OffendingCSharpConstruct!!,
                        SuggestedIssue: head.SuggestedIssue!!,
                        Occurrences: occurrences,
                        RetryHistory: MergeRetryHistory(
                            ordered.Select((a(AppId string, Artifact TriageArtifact)) -> a.Artifact)
                        )
                    }
                )
            }
            return gaps
        }

        private func MergeRetryHistory(artifacts IEnumerable[TriageArtifact]) List[TriageRetryEntry] {
            let seen = HashSet[string](StringComparer.Ordinal)
            let merged = List[TriageRetryEntry]()
            for artifact in artifacts {
                for entry in artifact.RetryHistory ?? List[TriageRetryEntry]() {
                    let key = (entry.RunId ?? string.Empty) +
                        "|" +
                        (entry.GscVersion ?? string.Empty) +
                        "|" +
                        (entry.Result ?? string.Empty)
                    if seen.Add(key) {
                        merged.Add(entry)
                    }
                }
            }
            return merged
                .OrderBy((e TriageRetryEntry) -> e.RunId, StringComparer.Ordinal)
                .ThenBy((e TriageRetryEntry) -> e.GscVersion!!, StringComparer.Ordinal)
                .ThenBy((e TriageRetryEntry) -> e.Result, StringComparer.Ordinal)
                .ToList()
        }
    }
}

/// One app's row in the status matrix: its id, overall result, and per-stage
/// statuses in execution order (ADR-0115 §F).
class AppReport {
    /// Gets or sets the corpus app id.
    @JsonPropertyName("appId")
    @JsonPropertyOrder(int32(0))
    prop AppId string

    /// Gets or sets a value indicating whether the app passed every stage.
    @JsonPropertyName("succeeded")
    @JsonPropertyOrder(int32(1))
    prop Succeeded bool

    /// Gets or sets a value indicating whether no stage failed but at least
    /// one is unverified. Never `true` together with a
    /// `false` (cref:Succeeded) (issue #1831).
    @JsonPropertyName("unverified")
    @JsonPropertyOrder(int32(2))
    prop Unverified bool

    /// Gets or sets the first failing stage's category, or null when green.
    @JsonPropertyName("failureCategory")
    @JsonPropertyOrder(int32(3))
    prop FailureCategory string?

    /// Gets or sets the per-stage statuses, in execution order.
    private var _stages List[StageResult] = List[StageResult]()

    @JsonPropertyName("stages")
    @JsonPropertyOrder(int32(4))
    prop Stages List[StageResult] {
        get {
            return _stages
        }
        set {
            _stages = value
        }
    }

    /// Gets or sets the run-relative triage artifact paths for this app.
    private var _artifacts List[string] = List[string]()

    @JsonPropertyName("artifacts")
    @JsonPropertyOrder(int32(5))
    prop Artifacts List[string] {
        get {
            return _artifacts
        }
        set {
            _artifacts = value
        }
    }

    /// Gets or sets the distinct fingerprints captured for this app.
    private var _fingerprints List[string] = List[string]()

    @JsonPropertyName("fingerprints")
    @JsonPropertyOrder(int32(6))
    prop Fingerprints List[string] {
        get {
            return _fingerprints
        }
        set {
            _fingerprints = value
        }
    }
}

/// One discovered gap (ADR-0115 §F): a single fingerprint, the representative
/// category/stage/diagnostic/construct and pre-rendered issue, every per-app
/// occurrence, and the merged retry history.
class GapReport {
    /// Gets or sets the dedup fingerprint (the gap key, §D.2).
    @JsonPropertyName("fingerprint")
    @JsonPropertyOrder(int32(0))
    prop Fingerprint string

    /// Gets or sets the triage category.
    @JsonPropertyName("category")
    @JsonPropertyOrder(int32(1))
    prop Category string

    /// Gets or sets the stage that produced the gap.
    @JsonPropertyName("stage")
    @JsonPropertyOrder(int32(2))
    prop Stage string

    /// Gets or sets the diagnostic id/message/severity.
    @JsonPropertyName("diagnostic")
    @JsonPropertyOrder(int32(3))
    prop Diagnostic TriageDiagnostic

    /// Gets or sets the offending construct kind plus a minimal snippet.
    @JsonPropertyName("offendingCSharpConstruct")
    @JsonPropertyOrder(int32(4))
    prop OffendingCSharpConstruct TriageOffendingConstruct

    /// Gets or sets the pre-rendered, ready-to-file issue.
    @JsonPropertyName("suggestedIssue")
    @JsonPropertyOrder(int32(5))
    prop SuggestedIssue TriageSuggestedIssue

    /// Gets or sets the per-app occurrences (appId + source location), sorted by app id.
    private var _occurrences List[GapOccurrence] = List[GapOccurrence]()

    @JsonPropertyName("occurrences")
    @JsonPropertyOrder(int32(6))
    prop Occurrences List[GapOccurrence] {
        get {
            return _occurrences
        }
        set {
            _occurrences = value
        }
    }

    /// Gets or sets the merged, deduped retry history for this fingerprint.
    private var _retryHistory List[TriageRetryEntry] = List[TriageRetryEntry]()

    @JsonPropertyName("retryHistory")
    @JsonPropertyOrder(int32(7))
    prop RetryHistory List[TriageRetryEntry] {
        get {
            return _retryHistory
        }
        set {
            _retryHistory = value
        }
    }
}

/// One occurrence of a gap: the corpus app that hit it plus the source-map
/// location recorded for that app (ADR-0115 §D.1/§F).
class GapOccurrence {
    /// Gets or sets the corpus app id that hit this gap.
    @JsonPropertyName("appId")
    @JsonPropertyOrder(int32(0))
    prop AppId string

    /// Gets or sets the source-map location for this occurrence.
    @JsonPropertyName("sourceLocation")
    @JsonPropertyOrder(int32(1))
    prop SourceLocation TriageSourceLocation
}
