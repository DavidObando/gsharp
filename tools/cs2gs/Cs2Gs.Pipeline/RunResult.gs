// <copyright file="RunResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System.Collections.Generic
import System.Text.Json.Serialization

/// The machine-readable summary of one whole-run pipeline execution: provenance
/// plus a per-app result list. This is the stable artifact the later
/// `Cs2Gs.Report` step aggregates (ADR-0115 §F); serialized with
/// (cref:TriageSerialization.Options).
class RunResult {
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
    prop GscVersion string?

    /// Gets or sets the resolved `gsc.dll` path.
    @JsonPropertyName("gscPath")
    @JsonPropertyOrder(int32(3))
    prop GscPath string?

    /// Gets or sets a value indicating whether every app passed every run stage.
    @JsonPropertyName("succeeded")
    @JsonPropertyOrder(int32(4))
    prop Succeeded bool

    /// Gets or sets a value indicating whether no app failed but at least one
    /// app has an unverified stage (a genuinely-unavailable dependency, e.g.
    /// no locally-built SDK). Mutually exclusive with a "failed" run: a
    /// skipped stage never overrides a failed one (ADR-0115 §C). Distinct
    /// from (cref:Succeeded) so the aggregate
    /// rollup cannot render "not verified" as verified-green (issue #1831,
    /// following the per-stage fix in issue #1749).
    @JsonPropertyName("unverified")
    @JsonPropertyOrder(int32(5))
    prop Unverified bool

    /// Gets or sets the per-app results.
    private var _apps List[AppResult] = List[AppResult]()

    @JsonPropertyName("apps")
    @JsonPropertyOrder(int32(6))
    prop Apps List[AppResult] {
        get {
            return _apps
        }
        set {
            _apps = value
        }
    }
}

/// The result of migrating one corpus app: its id, per-stage statuses, and the
/// triage artifact file paths produced (ADR-0115 §C/§D/§F).
class AppResult {
    /// Gets or sets the corpus app id.
    @JsonPropertyName("appId")
    @JsonPropertyOrder(int32(0))
    prop AppId string

    /// Gets or sets a value indicating whether the app passed every executed stage.
    @JsonPropertyName("succeeded")
    @JsonPropertyOrder(int32(1))
    prop Succeeded bool

    /// Gets or sets a value indicating whether no stage failed but at least
    /// one stage is `skipped` (a genuinely-unavailable dependency, not a
    /// pass). Never `true` when (cref:Succeeded) is
    /// `false` — a failed stage always takes precedence
    /// (ADR-0115 §C). This is the app-level counterpart of the per-stage
    /// "skipped" status (issue #1749); it exists so the aggregate rollup does
    /// not render an unverified app as green (issue #1831).
    @JsonPropertyName("unverified")
    @JsonPropertyOrder(int32(2))
    prop Unverified bool

    /// Gets or sets the category of the first failing stage, or null when green.
    @JsonPropertyName("failureCategory")
    @JsonPropertyOrder(int32(3))
    prop FailureCategory string?

    /// Gets or sets the per-stage results, in execution order.
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

    /// Gets or sets the run-relative paths of the triage artifacts produced for this app.
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

    /// Gets or sets the mirrored test failures the test-parity allow-list
    /// covered for this app (issue #3885). Present on a GREEN app: a run that
    /// passes only because of the allow-list must still say so, or the list
    /// becomes the invisible kind.
    private var _allowedTestFailures List[string] = List[string]()

    @JsonPropertyName("allowedTestFailures")
    @JsonPropertyOrder(int32(7))
    prop AllowedTestFailures List[string] {
        get {
            return _allowedTestFailures
        }
        set {
            _allowedTestFailures = value
        }
    }

    /// Gets or sets the allow-list entries for this app whose test did not fail
    /// in a completed run (issue #3885) — they are stale and should be removed.
    /// Advisory: reported, never a reason the gate goes red.
    private var _staleAllowListEntries List[string] = List[string]()

    @JsonPropertyName("staleAllowListEntries")
    @JsonPropertyOrder(int32(8))
    prop StaleAllowListEntries List[string] {
        get {
            return _staleAllowListEntries
        }
        set {
            _staleAllowListEntries = value
        }
    }

    /// Gets or sets the per-test-name parity summary of a mirrored test project
    /// (issue #4633), PASS or FAIL, so a passing app's case counts are
    /// auditable from the run record. `null` for apps that
    /// never reached a completed mirrored test run.
    @JsonPropertyName("testNameParity")
    @JsonPropertyOrder(int32(9))
    prop TestNameParity TestNameParitySummary?
}

/// Issue #4633: the per-test-name parity numbers for one mirrored test project.
class TestNameParitySummary {
    /// Gets or sets the mode: (cref:PerNameMode) or (cref:CountOnlyMode).
    private var _mode string = CountOnlyMode

    @JsonPropertyName("mode")
    @JsonPropertyOrder(int32(0))
    prop Mode string {
        get {
            return _mode
        }
        set {
            _mode = value
        }
    }

    /// Gets or sets the number of cases the C# original's discovery listed.
    @JsonPropertyName("csharpCases")
    @JsonPropertyOrder(int32(1))
    prop CSharpCases int32

    /// Gets or sets the number of results in the migrated run's TRX.
    @JsonPropertyName("migratedCases")
    @JsonPropertyOrder(int32(2))
    prop MigratedCases int32

    /// Gets or sets the number of C# cases matched by a migrated result.
    @JsonPropertyName("matched")
    @JsonPropertyOrder(int32(3))
    prop Matched int32

    /// Gets or sets the migrated rows matched to a non-enumerated C# theory.
    @JsonPropertyName("theoryRows")
    @JsonPropertyOrder(int32(4))
    prop TheoryRows int32

    /// Gets or sets the number of C# cases the migrated run lacks (before the baseline).
    @JsonPropertyName("missing")
    @JsonPropertyOrder(int32(5))
    prop Missing int32

    /// Gets or sets the number of migrated cases the oracle lacks (before the baseline).
    @JsonPropertyName("extra")
    @JsonPropertyOrder(int32(6))
    prop Extra int32

    /// Gets or sets the number of differences a baseline entry explained.
    @JsonPropertyName("explained")
    @JsonPropertyOrder(int32(7))
    prop Explained int32

    /// Gets or sets the baseline entries for this app that explained nothing (advisory).
    private var _staleBaselineEntries List[string] = List[string]()

    @JsonPropertyName("staleBaselineEntries")
    @JsonPropertyOrder(int32(8))
    prop StaleBaselineEntries List[string] {
        get {
            return _staleBaselineEntries
        }
        set {
            _staleBaselineEntries = value
        }
    }

    shared {
        /// The mode recorded when the C# oracle was compared name for name.
        const PerNameMode string = "per-name"

        /// The mode recorded when no oracle directory was configured.
        const CountOnlyMode string = "count-only"
    }
}

/// The status of one stage within one app's migration (ADR-0115 §C).
class StageResult {
    /// Gets or sets the stage name (`translate`/`compile`/…).
    @JsonPropertyName("stage")
    @JsonPropertyOrder(int32(0))
    prop Stage string

    /// Gets or sets the stage status (`passed`/`failed`/`skipped`).
    @JsonPropertyName("status")
    @JsonPropertyOrder(int32(1))
    prop Status string

    /// Gets or sets the number of triage artifacts the stage produced.
    @JsonPropertyName("artifactCount")
    @JsonPropertyOrder(int32(2))
    prop ArtifactCount int32
}
