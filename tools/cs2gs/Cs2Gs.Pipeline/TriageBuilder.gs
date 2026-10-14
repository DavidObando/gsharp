// <copyright file="TriageBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import Cs2Gs.Translator
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Text.RegularExpressions

/// Builds schema-v1.0 triage artifacts (ADR-0115 §D.1), pre-stamped with the
/// run provenance, computing the dedup fingerprint (§D.2) and the pre-rendered
/// `suggestedIssue`. The `retryHistory` is left empty here and filled
/// by (cref:MigrationPipeline), which alone sees prior runs.
class TriageBuilder {
    /// Initializes a new instance of the (cref:TriageBuilder) class.
    /// @param runId The run id stamped on every artifact.
    /// @param timestamp The ISO-8601 UTC run timestamp.
    /// @param gscVersion The compiler version stamped on every artifact.
    /// @param corpusAppId The corpus app id stamped on every artifact.
    init(runId string, timestamp string, gscVersion string?, corpusAppId string) {
        this.RunId = runId
        this.Timestamp = timestamp
        this.GscVersion = gscVersion
        this.CorpusAppId = corpusAppId
    }

    /// Gets the run id.
    prop RunId string {
        get;
    }

    /// Gets the ISO-8601 UTC run timestamp.
    prop Timestamp string {
        get;
    }

    /// Gets the compiler version.
    prop GscVersion string? {
        get;
    }

    /// Gets the corpus app id.
    prop CorpusAppId string {
        get;
    }

    /// Builds a stage-1 `translation-unsupported` artifact from a translator
    /// diagnostic. The C# location/snippet come from the diagnostic's Roslyn
    /// location; the G# side is `null` because no canonical
    /// `.gs` is emitted for an unsupported construct (documented null rule).
    /// @param diagnostic The translator diagnostic.
    /// @returns The populated triage artifact.
    func TranslationUnsupported(diagnostic TranslationDiagnostic?) TriageArtifact {
        if diagnostic == nil {
            throw ArgumentNullException("diagnostic")
        }
        var (csFile, csLine, csColumn, snippet) = ResolveCSharpLocation(diagnostic.Location)
        snippet ??= diagnostic.Message
        let artifact = this.NewArtifact(MigrationStageKind.Translate, TriageCategory.TranslationUnsupported)
        // ADR-0138: a construct registered as deliberately rejected keeps the
        // long-standing CS2GS-UNSUPPORTED id; an accidental fallthrough (a
        // construct neither translated nor registered with a rationale) is a
        // coverage hole and gets its own id so ledger/CI can treat it as a
        // distinct, always-actionable class.
        let diagnosticId = diagnostic.DiagnosticId ??
            (
            if diagnostic.Classification == UnsupportedClassification.ByDesign {
                "CS2GS-UNSUPPORTED"
            } else {
                "CS2GS-GAP"
            }
        )
        artifact.Diagnostic = TriageDiagnostic{Id: diagnosticId, Message: diagnostic.Message!!, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: nil,
            GsLine: nil,
            GsColumn: nil,
            CsFile: csFile,
            CsLine: csLine,
            CsColumn: csColumn
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: diagnostic.ConstructKind,
            Snippet: Truncate(snippet)
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            snippet
        )
        artifact.SuggestedIssue = this.UnsupportedIssue(artifact)
        return artifact
    }

    /// Builds a stage-1 `translation-unsupported` artifact for an emitted
    /// `.gs` that fails to round-trip-parse — a translator defect that still
    /// gates stage 1 (ADR-0115 §C).
    /// @param file The emitted G# file that failed to parse.
    /// @param parseError The first G# parser error text.
    /// @returns The populated triage artifact.
    func RoundTripFailure(file EmittedGsFile?, parseError string) TriageArtifact {
        if file == nil {
            throw ArgumentNullException("file")
        }
        let artifact = this.NewArtifact(MigrationStageKind.Translate, TriageCategory.TranslationUnsupported)
        artifact.Diagnostic = TriageDiagnostic{
            Id: "CS2GS-ROUNDTRIP",
            Message: "Emitted G# did not round-trip-parse: " + parseError,
            Severity: "error"
        }
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: file.RelativeGsPath,
            GsLine: nil,
            GsColumn: nil,
            CsFile: file.CsFilePath,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: "CompilationUnit",
            Snippet: Truncate(parseError)
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            parseError
        )
        artifact.SuggestedIssue = this.UnsupportedIssue(artifact)
        return artifact
    }

    /// Builds an artifact for a project that failed to bind in C# — MSBuild
    /// workspace load errors captured in
    /// (cref:Cs2Gs.Translator.Loading.LoadedCSharpProject.ErrorDiagnostics)
    /// (ADR-0115 §C, issue #1742). Callers must check
    /// (cref:Cs2Gs.Translator.Loading.LoadedCSharpProject.BoundWithoutErrors)
    /// and stop before translating any document: a project that does not even
    /// bind produces only confusing downstream binding noise otherwise.
    /// @param stage The stage the load happened in (its own project for stage 1, the `.Tests` project for
    /// stage 4).
    /// @param category The triage category to file the artifact under.
    /// @param errors The load-error diagnostics
    /// ((cref:Cs2Gs.Translator.Loading.LoadedCSharpProject.ErrorDiagnostics)).
    /// @returns The populated triage artifact.
    func ProjectLoadFailure(
        stage MigrationStageKind,
        category TriageCategory,
        errors IReadOnlyList[Diagnostic]?
    ) TriageArtifact {
        if errors == nil || errors.Count == 0 {
            throw ArgumentException("errors must be a non-empty list.", "errors")
        }
        let message = string.Join(" | ", errors.Select((d Diagnostic) -> d.GetMessage()))
        let artifact = this.NewArtifact(stage, category)
        artifact.Diagnostic = TriageDiagnostic{Id: errors[0].Id, Message: message, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: nil,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{Kind: "ProjectLoad", Snippet: Truncate(message)}
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            message
        )
        artifact.SuggestedIssue = this.ProjectLoadIssue(artifact)
        return artifact
    }

    /// Builds a stage-2 `compile-error` artifact from a single `gsc`
    /// diagnostic. The G# location is precise (from `gsc`); the C# side is
    /// `null` because the translator keeps no per-line C#↔G#
    /// position map yet (documented null rule). The offending construct is the
    /// emitted G# line that `gsc` flagged.
    /// @param diagnostic The `gsc` error diagnostic.
    /// @param file The emitted G# file the diagnostic anchors to.
    /// @returns The populated triage artifact.
    func CompileError(diagnostic GscDiagnostic?, file EmittedGsFile?) TriageArtifact {
        if diagnostic == nil {
            throw ArgumentNullException("diagnostic")
        }
        // Issue #3347: when the emitted file cannot be resolved, say so. This used
        // to fall back to `diagnostic.Message`, which put the DIAGNOSTIC TEXT in
        // the "Offending line" field — indistinguishable from a real source line
        // to anyone reading the report, and the reason a whole oahu triage cycle
        // showed no usable source at all. An explicit marker keeps the failure
        // visible instead of plausible.
        let snippet string? = if file == nil {
            default(string?)
        } else {
            LineAt(file.GSharpSource, diagnostic.Line)
        }
        let kind = ClassifyGsLine(snippet)
        let offendingLine = snippet ?? UnresolvedEmittedLine
        let artifact = this.NewArtifact(MigrationStageKind.Compile, TriageCategory.CompileError)
        artifact.Diagnostic = TriageDiagnostic{
            Id: diagnostic.Id,
            Message: diagnostic.Message,
            Severity: diagnostic.Severity
        }
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: file?.RelativeGsPath,
            GsLine: diagnostic.Line,
            GsColumn: diagnostic.Column,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{Kind: kind, Snippet: Truncate(offendingLine)}
        // The fingerprint deliberately keeps using the diagnostic message rather
        // than the marker: the marker is a constant, so hashing it would make
        // every unresolved artifact identical. (Message normalization still
        // dedups genuinely-similar diagnostics — see issue #1750.)
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            snippet ?? diagnostic.Message
        )
        artifact.SuggestedIssue = this.CompileIssue(artifact)
        return artifact
    }

    /// Builds a stage-3 `ilverify-failure` artifact from a single parsed
    /// `ilverify` error (ADR-0115 §C/§D). The diagnostic id is the ilverify
    /// error code; the offending construct kind is the failing IL method
    /// skeleton (the best available signal, since the translator keeps no
    /// per-line C#↔G# map yet — a documented fallback when the method is
    /// absent). The C#/G# source positions are `null` for the
    /// same reason. Labels are `Oats` + `cil-emit` (§D).
    /// @param error The parsed ilverify error.
    /// @param gsFile The emitted G# file (relative path), or null.
    /// @returns The populated triage artifact.
    func IlVerifyFailure(error IlVerifyError?, gsFile string? = nil) TriageArtifact {
        if error == nil {
            throw ArgumentNullException("error")
        }
        let kind string? = if string.IsNullOrWhiteSpace(error.Method) {
            "IlMethod"
        } else {
            error.Method
        }
        let artifact = this.NewArtifact(MigrationStageKind.IlVerify, TriageCategory.IlVerifyFailure)
        artifact.Diagnostic = TriageDiagnostic{
            Id: if string.IsNullOrWhiteSpace(error.Code) {
                "IlVerifyError"
            } else {
                error.Code
            },
            Message: error.RawLine,
            Severity: "error"
        }
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: kind,
            Snippet: Truncate(error.Method ?? error.RawLine)
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            error.Method ?? error.RawLine
        )
        artifact.SuggestedIssue = this.IlVerifyIssue(artifact)
        return artifact
    }

    /// Builds a stage-4 `test-parity-failure` artifact for an executable
    /// app whose migrated program stdout diverged from the committed
    /// `baseline.stdout.golden` (ADR-0115 §C/§E). The diagnostic id is
    /// `STDOUT-MISMATCH`; the message summarizes the first differing line;
    /// `offendingCSharpConstruct.kind` is `ProgramStdout` with the
    /// differing line as the snippet. The C#/G# source positions are
    /// `null` (the divergence is observed at runtime, not at a
    /// source position). Labels are `Oats` + `bug` (§D).
    /// @param diff The stdout parity mismatch.
    /// @param gsFile The emitted G# file (relative path), or null.
    /// @returns The populated triage artifact.
    func TestParityStdoutFailure(diff StdoutParityResult?, gsFile string? = nil) TriageArtifact {
        if diff == nil {
            throw ArgumentNullException("diff")
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{Id: "STDOUT-MISMATCH", Message: diff.Describe(), Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: "ProgramStdout",
            Snippet: Truncate(diff.ExpectedLine ?? diff.ActualLine ?? diff.Describe())
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            diff.ExpectedLine ?? diff.ActualLine ?? diff.Describe()
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Builds a stage-4 `test-parity-failure` artifact for a single ported
    /// xUnit test whose outcome diverged from the C# baseline oracle
    /// (ADR-0115 §C/§E). The diagnostic id is `TESTPARITY-<kind>`
    /// (`Missing`/`Extra`/`OutcomeMismatch`); the message is the
    /// expected-vs-actual description; `offendingCSharpConstruct.kind` is
    /// the failing test method skeleton (the fully qualified test name). Labels
    /// are `Oats` + `bug` (§D). The fingerprint splits per differing
    /// test (the test name is the construct kind).
    /// @param diff The per-test parity difference.
    /// @param gsFile The emitted G# test file (relative path), or null.
    /// @returns The populated triage artifact.
    func TestParityTestFailure(diff TestParityDiff?, gsFile string? = nil) TriageArtifact {
        if diff == nil {
            throw ArgumentNullException("diff")
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{
            Id: "TESTPARITY-" + diff.Kind.ToString(),
            Message: diff.Describe(),
            Severity: "error"
        }
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: diff.Name,
            Snippet: Truncate(diff.Describe())
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            diff.Describe()
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Builds a stage-4 `test-parity-failure` artifact for a library app
    /// whose translated G# test project failed to build against the
    /// locally-built `Gsharp.NET.Sdk` (issue #1749 mode 1). A library that
    /// green-built standalone with `gsc` in stage 2 but fails to build here
    /// is a real regression — the SDK/build surface broke, not "not verified
    /// yet" — so this is reported as a failure, never a skip. The diagnostic id
    /// is `LIBRARY-BUILD-FAILED`; the message is the tail of the captured
    /// `dotnet test` output.
    /// @param output The captured `dotnet test` output (already truncated by the caller).
    /// @param gsFile The emitted G# library file (relative path), or null.
    /// @returns The populated triage artifact.
    func TestParityLibraryBuildFailure(output string, gsFile string? = nil) TriageArtifact {
        let message = if string.IsNullOrWhiteSpace(output) {
            "(no build output captured)"
        } else {
            output.Trim()
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{Id: "LIBRARY-BUILD-FAILED", Message: message, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{Kind: "LibraryBuild", Snippet: Truncate(message)}
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            message
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Issue #3869: builds a triage artifact for a mirrored test project whose
    /// `dotnet test` exited 0 without actually running its tests (or ran
    /// materially fewer than the C# original declares). `dotnet test` exits
    /// 0 when it discovers nothing, so a migrated assembly that fails to
    /// type-load — and therefore enumerates no test classes at all — used to
    /// score a full `test-parity PASS`. The diagnostic id is
    /// `NO-TESTS-RAN`.
    /// @param reason The machine-generated reason the run is not green.
    /// @param output The captured `dotnet test` output.
    /// @param gsFile The emitted G# library file (relative path), or null.
    /// @returns The populated triage artifact.
    func TestParityNoTestsRan(reason string, output string, gsFile string? = nil) TriageArtifact {
        var message = if string.IsNullOrWhiteSpace(reason) {
            "no tests ran"
        } else {
            reason.Trim()
        }
        if !string.IsNullOrWhiteSpace(output) {
            message += "\n" + output.Trim()
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{Id: "NO-TESTS-RAN", Message: message, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: "LibraryTestDiscovery",
            Snippet: Truncate(message)
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            message
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Issue #4633: builds a triage artifact for a mirrored test project whose
    /// per-test-name parity could not be established or did not hold. One
    /// artifact per app, not one per differing name: a whole class going
    /// missing would otherwise file thousands. The diagnostic id names the
    /// failure (`TEST-NAME-PARITY`, `TEST-ORACLE-MISSING`,
    /// `TEST-ORACLE-INVALID`, `TEST-RESULTS-UNREADABLE`). The
    /// fingerprint is computed from `fingerprintKey` when given (the stage
    /// passes the sorted differences, or the failure kind and app) and from the
    /// message text only otherwise, so runner paths in a message never split
    /// one failure into many fingerprints.
    /// @param id The diagnostic id.
    /// @param message The human-readable description, differences included.
    /// @param gsFile The emitted G# file (relative path), or null.
    /// @param fingerprintKey The stable identity of the failure (the sorted differences, or the
    /// failure kind and app); the message can carry runner-specific paths, so
    /// it is used only when no key is given.
    /// @returns The populated triage artifact.
    func TestParityNameMismatch(
        id string,
        message string,
        gsFile string? = nil,
        fingerprintKey string? = nil
    ) TriageArtifact {
        let text = if string.IsNullOrWhiteSpace(message) {
            "per-test-name parity failed"
        } else {
            message.Trim()
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{Id: id, Message: text, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{Kind: "TestNameParity", Snippet: Truncate(text)}
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            fingerprintKey ?? text
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Issue #2867: builds a triage artifact for a mirrored test project that
    /// BUILT and RAN but whose tests failed. Reporting this as
    /// `LIBRARY-BUILD-FAILED` points investigation at the
    /// translator/emitter ("a real regression, not translation pending") when
    /// the actual signal is a runtime test failure, and is the same class of
    /// misleading degradation as #2842. The diagnostic id is
    /// `LIBRARY-TESTS-FAILED`. Its fingerprint uses the complete,
    /// normalized failing-test identity set. If the console output does not
    /// contain every identity reported by the run summary, the artifact says
    /// so and uses an explicit app-scoped unclassified fingerprint instead of
    /// pretending the failure shares a root cause with another app.
    /// @param output The captured `dotnet test` output.
    /// @param gsFile The emitted G# library file (relative path), or null.
    /// @returns The populated triage artifact.
    func TestParityLibraryTestFailure(output string, gsFile string? = nil) TriageArtifact {
        let message = if string.IsNullOrWhiteSpace(output) {
            "(no test output captured)"
        } else {
            output.Trim()
        }
        let failingTests = TestParityAllowList.ParseFailedTestNames(message)
        let reportedFailures = TestParityAllowList.ReportedFailureCount(message)
        let hasCompleteFailureIdentities = reportedFailures > 0 && failingTests.Count == reportedFailures
        var fingerprintNotice string? = nil
        if !hasCompleteFailureIdentities {
            fingerprintNotice = "Fingerprint evidence unavailable: captured ${failingTests.Count} of " +
                "$reportedFailures reported failing test identities. The fingerprint is " +
                "unclassified and scoped only to '${this.CorpusAppId}'; equality with another " +
                "fingerprint does not imply a shared cause."
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{
            Id: "LIBRARY-TESTS-FAILED",
            Message: if fingerprintNotice == nil {
                message
            } else {
                fingerprintNotice + Environment.NewLine + message
            },
            Severity: "error"
        }
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{Kind: "LibraryTestRun", Snippet: Truncate(message)}
        artifact.Fingerprint = Fingerprint.ComputeTestParityFailure(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            if hasCompleteFailureIdentities {
                failingTests
            } else {
                cast[IReadOnlyList[string]](Array.Empty[string]())
            },
            this.CorpusAppId
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Issue #3931: builds a triage artifact for a mirrored test project whose
    /// `dotnet test` was KILLED on the runner's wall-clock budget. A
    /// killed run produces no `Passed!/Failed! … Total: N` summary, only
    /// a partial `[FAIL]` list — so any count taken from it is a
    /// truncation artifact, not a result. Reporting it as
    /// `LIBRARY-BUILD-FAILED` (what the absent summary line otherwise
    /// classifies it as) makes a timeout indistinguishable from a genuine
    /// build break, and lets a truncated `[FAIL]` list be read as a
    /// parity number. The dedicated id is `LIBRARY-TESTS-TIMED-OUT`.
    /// @param budget The wall-clock budget the run exceeded.
    /// @param output The captured (partial) `dotnet test` output.
    /// @param gsFile The emitted G# library file (relative path), or null.
    /// @returns The populated triage artifact.
    func TestParityLibraryTestRunTimedOut(budget TimeSpan, output string, gsFile string? = nil) TriageArtifact {
        var message = "the migrated test run exceeded its $budget budget and was killed; " +
            "the output below is TRUNCATED and carries no run summary, so its " +
            "[FAIL] list is not a parity count."
        if !string.IsNullOrWhiteSpace(output) {
            message += "\n" + output.Trim()
        }
        let artifact = this.NewArtifact(MigrationStageKind.TestParity, TriageCategory.TestParityFailure)
        artifact.Diagnostic = TriageDiagnostic{Id: "LIBRARY-TESTS-TIMED-OUT", Message: message, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: gsFile,
            GsLine: nil,
            GsColumn: nil,
            CsFile: nil,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{
            Kind: "LibraryTestRunTimeout",
            Snippet: "dotnet test killed on the mirrored-test-run budget"
        }
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            artifact.OffendingCSharpConstruct!!.Snippet
        )
        artifact.SuggestedIssue = this.TestParityIssue(artifact)
        return artifact
    }

    /// Builds a triage artifact for an unhandled exception thrown by a stage
    /// itself, rather than a diagnostic the stage reported normally (issue
    /// #1750). The offending construct `kind` is the exception's runtime
    /// type name — a structural, deterministic signal — rather than any text
    /// pulled from (cref:Exception.Message): crash messages routinely
    /// embed run-scoped absolute paths (temp/work directories that include the
    /// run id) that differ machine-to-machine and run-to-run, so fingerprinting
    /// on the raw message text kept the same recurring crash from ever
    /// deduping. (cref:Exception.Message) is still recorded in full on
    /// (cref:TriageDiagnostic.Message) for human triage; it is simply
    /// not the fingerprint's construct-kind signal (its embedded paths are
    /// also normalized generically by (cref:Fingerprint.NormalizeShape)
    /// as a second line of defense).
    /// @param stage The stage that crashed.
    /// @param category The triage category to file the crash artifact under.
    /// @param diagnosticId The diagnostic id to stamp (stage-specific, e.g. `GS9999`).
    /// @param ex The exception the stage threw.
    /// @param csFile The C# file the stage was working on when it threw, when the stage knows
    /// it (issue #3804). A crash artifact with no location at all is nearly
    /// unactionable — "translate stage crashed", no file, no line — so the
    /// stage annotates the throw with the source it had on the table and it is
    /// recorded here. Deliberately NOT part of the fingerprint, for the same
    /// reason the message is not: it is a run-scoped absolute path.
    /// @returns The populated triage artifact.
    func StageCrash(
        stage MigrationStageKind,
        category TriageCategory,
        diagnosticId string,
        ex Exception?,
        csFile string? = nil
    ) TriageArtifact {
        if ex == nil {
            throw ArgumentNullException("ex")
        }
        let kind = ex.GetType().Name
        let message = "${TriageSerialization.StageName(stage)} stage crashed ($kind): ${ex.Message}"
        let artifact = this.NewArtifact(stage, category)
        artifact.Diagnostic = TriageDiagnostic{Id: diagnosticId, Message: message, Severity: "error"}
        artifact.SourceLocation = TriageSourceLocation{
            GsFile: nil,
            GsLine: nil,
            GsColumn: nil,
            CsFile: csFile,
            CsLine: nil,
            CsColumn: nil
        }
        artifact.OffendingCSharpConstruct = TriageOffendingConstruct{Kind: kind, Snippet: Truncate(message)}
        artifact.Fingerprint = Fingerprint.Compute(
            artifact.Category,
            artifact.Stage,
            artifact.Diagnostic!!.Id,
            artifact.OffendingCSharpConstruct!!.Kind,
            message
        )
        artifact.SuggestedIssue = switch category {
            case TriageCategory.PipelineCrash: this.CrashIssue(artifact, stage)
            case TriageCategory.CompileError: this.CompileIssue(artifact)
            case TriageCategory.IlVerifyFailure: this.IlVerifyIssue(artifact)
            case TriageCategory.TestParityFailure: this.TestParityIssue(artifact)
            default: this.UnsupportedIssue(artifact)
        }
        return artifact
    }

    private func NewArtifact(stage MigrationStageKind, category TriageCategory) TriageArtifact {
        let artifact = TriageArtifact{
            RunId: this.RunId,
            Timestamp: this.Timestamp,
            GscVersion: this.GscVersion,
            CorpusAppId: this.CorpusAppId,
            Stage: TriageSerialization.StageName(stage),
            Category: TriageSerialization.CategoryName(category)
        }
        return artifact
    }

    private func UnsupportedIssue(artifact TriageArtifact) TriageSuggestedIssue {
        let title = "[cs2gs] Unsupported C# construct '${artifact.OffendingCSharpConstruct!!.Kind}' " +
            "has no canonical G# form (${this.CorpusAppId})"
        let csLine = "- C# source: `${artifact.SourceLocation.CsFile}`" +
            LocationSuffix(artifact.SourceLocation.CsLine, artifact.SourceLocation.CsColumn)
        let lines[]string = []string{
            "While migrating **${this.CorpusAppId}**, the translator could not map a C# construct to canonical G#.",
            string.Empty,
            "- Construct: `${artifact.OffendingCSharpConstruct!!.Kind}`",
            "- Detail: ${artifact.Diagnostic!!.Message}",
            csLine,
            "- Snippet: `${artifact.OffendingCSharpConstruct!!.Snippet}`",
            string.Empty,
            "**Reproduction:** run `cs2gs migrate` over the corpus; stage 1 (translate) gates on this construct.",
            "**Fingerprint:** `${artifact.Fingerprint}`"
        }
        let issue = TriageSuggestedIssue{Title: title, Body: string.Join("\n", lines)}
        issue.Labels.Add("Oats")
        return issue
    }

    /// Issue #3804: the suggested issue for a stage that CRASHED. The old
    /// rendering reused (cref:UnsupportedIssue), which titles itself
    /// "Unsupported C# construct '`X`' has no canonical G# form" with the
    /// exception's type name in the construct slot — so a cs2gs
    /// `IndexOutOfRangeException` was published as a G# language gap and
    /// read as already-triaged. This one says what actually happened, and
    /// names the file the stage was on when it happened.
    /// @param artifact The crash artifact.
    /// @param stage The stage that crashed.
    /// @returns The suggested issue.
    private func CrashIssue(artifact TriageArtifact, stage MigrationStageKind) TriageSuggestedIssue {
        let stageName = TriageSerialization.StageName(stage)
        let title = "[cs2gs] $stageName stage crashed " +
            "(${artifact.OffendingCSharpConstruct!!.Kind}) migrating ${this.CorpusAppId}"
        let fileLine = if string.IsNullOrEmpty(artifact.SourceLocation.CsFile) {
            "- C# source: not captured (the stage crashed outside a per-file step)"
        } else {
            "- C# source: `${artifact.SourceLocation.CsFile}`"
        }
        let lines[]string = []string{
            "`cs2gs` itself threw while migrating **${this.CorpusAppId}** — this is a DEFECT IN THE " +
                "MIGRATION TOOL, not a C# construct without a G# form. Fix the crash at its cause; if " +
                "the construct really has no G# form, it needs a proper unsupported-construct report " +
                "naming the construct, which a crash is not.",
            string.Empty,
            "- Stage: `$stageName`",
            "- Exception: `${artifact.OffendingCSharpConstruct!!.Kind}`",
            "- Detail: ${artifact.Diagnostic!!.Message}",
            fileLine,
            string.Empty,
            "**Reproduction:** run `cs2gs migrate` over the corpus; the stage log carries the stack trace.",
            "**Fingerprint:** `${artifact.Fingerprint}`"
        }
        let issue = TriageSuggestedIssue{Title: title, Body: string.Join("\n", lines)}
        issue.Labels.Add("Oats")
        return issue
    }

    private func ProjectLoadIssue(artifact TriageArtifact) TriageSuggestedIssue {
        let title = "[cs2gs] project failed to load (${this.CorpusAppId})"
        let lines[]string = []string{
            "MSBuild could not bind the C# project for **${this.CorpusAppId}** " +
                "(gsc ${this.GscVersion}) — missing SDK/targets, an unresolved project reference, " +
                "or an unsupported TFM.",
            string.Empty,
            "- Diagnostic: `${artifact.Diagnostic!!.Id}` — ${artifact.Diagnostic!!.Message}",
            string.Empty,
            "**Reproduction:** run `cs2gs migrate` over the corpus; the project load gate fails before " +
                "any document is translated.",
            "**Fingerprint:** `${artifact.Fingerprint}`"
        }
        let issue = TriageSuggestedIssue{Title: title, Body: string.Join("\n", lines)}
        issue.Labels.Add("Oats")
        return issue
    }

    private func CompileIssue(artifact TriageArtifact) TriageSuggestedIssue {
        let title = "[cs2gs] ${artifact.Diagnostic!!.Id} compiling translated ${this.CorpusAppId} " +
            "(${artifact.OffendingCSharpConstruct!!.Kind})"
        let gsLine = "- Emitted G#: `${artifact.SourceLocation.GsFile}`" +
            LocationSuffix(artifact.SourceLocation.GsLine, artifact.SourceLocation.GsColumn)
        let repro = "**Reproduction:** `cs2gs migrate` translates the corpus app, writes the `.gs` shown above, " +
            "then runs `gsc /target:… /out:… ${artifact.SourceLocation.GsFile}` which surfaces this error."
        let lines[]string = []string{
            "The G# emitted for **${this.CorpusAppId}** fails to compile with `gsc` ${this.GscVersion}.",
            string.Empty,
            "- Diagnostic: `${artifact.Diagnostic!!.Id}` — ${artifact.Diagnostic!!.Message}",
            gsLine,
            "- Offending line: `${artifact.OffendingCSharpConstruct!!.Snippet}`",
            string.Empty,
            repro,
            "**Fingerprint:** `${artifact.Fingerprint}`"
        }
        let issue = TriageSuggestedIssue{Title: title, Body: string.Join("\n", lines)}
        issue.Labels.Add("Oats")
        issue.Labels.Add("bug")
        return issue
    }

    private func IlVerifyIssue(artifact TriageArtifact) TriageSuggestedIssue {
        let title = "[cs2gs] ilverify ${artifact.Diagnostic!!.Id} in translated ${this.CorpusAppId} " +
            "(${artifact.OffendingCSharpConstruct!!.Kind})"
        let repro = "**Reproduction:** `cs2gs migrate` translates the corpus app, compiles it with `gsc`, " +
            "then runs `dotnet tool run ilverify <assembly> -s System.Private.CoreLib -r <refs>` which surfaces this error."
        let lines[]string = []string{
            "The assembly emitted for **${this.CorpusAppId}** fails IL verification with " +
                "`dotnet-ilverify` (gsc ${this.GscVersion}).",
            string.Empty,
            "- Error code: `${artifact.Diagnostic!!.Id}`",
            "- Method: `${artifact.OffendingCSharpConstruct!!.Kind}`",
            "- ilverify: `${artifact.Diagnostic!!.Message}`",
            string.Empty,
            "This is a CIL-emission gap: `gsc` accepted the program but produced IL the verifier rejects " +
                "(and the error is not one of the two documented ilverify false-positive bundles).",
            repro,
            "**Fingerprint:** `${artifact.Fingerprint}`"
        }
        let issue = TriageSuggestedIssue{Title: title, Body: string.Join("\n", lines)}
        issue.Labels.Add("Oats")
        issue.Labels.Add("cil-emit")
        return issue
    }

    private func TestParityIssue(artifact TriageArtifact) TriageSuggestedIssue {
        let title = "[cs2gs] test-parity ${artifact.Diagnostic!!.Id} in migrated ${this.CorpusAppId} " +
            "(${artifact.OffendingCSharpConstruct!!.Kind})"
        let isStdout = string.Equals(artifact.Diagnostic!!.Id, "STDOUT-MISMATCH", StringComparison.Ordinal)
        let isBuildFailure = string.Equals(artifact.Diagnostic!!.Id, "LIBRARY-BUILD-FAILED", StringComparison.Ordinal)
        let repro = if isStdout {
            "**Reproduction:** `cs2gs migrate` translates the corpus app, compiles it with `gsc`, runs the " +
                "produced program, and compares its stdout to `baseline.stdout.golden`."
        } else {
            "**Reproduction:** `cs2gs migrate` translates the corpus app and its `.Tests` project to a G# xUnit " +
                "project, runs `dotnet test`, and compares the per-test outcomes to `baseline.tests.json`."
        }
        let lines[]string = []string{
            "The migrated **${this.CorpusAppId}** does not reproduce the C# parity oracle with `gsc` ${this.GscVersion}.",
            string.Empty,
            "- Failure: `${artifact.Diagnostic!!.Id}`",
            "- Detail: ${artifact.Diagnostic!!.Message}",
            if isStdout {
                "- This is a behavioral divergence: the program compiled but produced different output."
            } else {
                (
                    if isBuildFailure {
                        "- This is a build regression: the app compiled with `gsc` in stage 2 but the " +
                            "translated G# test project failed to build against the locally-built SDK here."
                    } else {
                        "- Failing test: `${artifact.OffendingCSharpConstruct!!.Kind}`"
                    }
                )
            },
            string.Empty,
            repro,
            "**Fingerprint:** `${artifact.Fingerprint}`"
        }
        let issue = TriageSuggestedIssue{Title: title, Body: string.Join("\n", lines)}
        issue.Labels.Add("Oats")
        issue.Labels.Add("bug")
        return issue
    }

    shared {
        /// Stands in for the emitted G# line when the diagnostic's file cannot be
        /// resolved back to an `EmittedGsFile`. Explicit rather than silently
        /// substituting the diagnostic message, so a lookup failure is visible in the
        /// report instead of masquerading as source (issue #3347).
        internal const UnresolvedEmittedLine string = "<emitted G# line unavailable: diagnostic file did not resolve to an emitted .gs>"

        private const SnippetMaxLength int32 = 160

        // The leading identifier/keyword token of a (trimmed) line — the position
        // a G# statement/declaration keyword actually occupies syntactically.
        // Used by ClassifyGsLine (issue #1750) instead of scanning the whole line,
        // which can match keyword text that only happens to appear inside a
        // string literal.
        private let LeadingTokenPattern Regex = Regex(
            "^[A-Za-z_][A-Za-z0-9_]*",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        // Every modifier keyword the G# printer can emit ahead of a construct
        // keyword (issue #1750 B1), audited from Cs2Gs.CodeModel.Printing.GSharpPrinter:
        // RenderVisibility (public/internal/private/protected), the unsafe/open/
        // sealed/abstract prefixes on RenderTypeDeclaration, the open/override
        // prefixes on RenderProperty, the open/override/async prefixes on
        // RenderMethod, and the `inline` prefix RenderKindKeyword emits ahead of
        // `struct` for TypeDeclarationKind.InlineStruct (issue #1851). `static`,
        // `virtual`, and `export` are not currently emitted by the printer but are
        // kept in the set defensively so a future modifier the printer starts
        // emitting doesn't silently collapse back into the generic bucket.
        // `data` (DataClass/DataStruct's `data class`/`data struct`) is
        // deliberately NOT added here: it is already its own entry in the
        // construct-keyword list below, so those lines classify as
        // DataConstruct rather than falling through to the generic bucket.
        private let ModifierTokens HashSet[string] = HashSet[string](StringComparer.Ordinal){
            "public",
            "private",
            "internal",
            "protected",
            "static",
            "async",
            "sealed",
            "abstract",
            "virtual",
            "override",
            "export",
            "open",
            "unsafe",
            "inline"
        }

        private func ResolveCSharpLocation(location Location?)(
            File string?,
            Line int32?,
            Column int32?,
            Snippet string?
        ) {
            if location == nil || !location.IsInSource {
                return (nil, nil, nil, nil)
            }
            let span = location.GetLineSpan()
            let line = span.StartLinePosition.Line + 1
            let column = span.StartLinePosition.Character + 1
            var snippet string? = nil
            let text SourceText? = location.SourceTree?.GetText()
            if text != nil && span.StartLinePosition.Line < text.Lines.Count {
                snippet = text.Lines[span.StartLinePosition.Line].ToString().Trim()
            }
            return (span.Path, line, column, snippet)
        }

        private func LineAt(source string, oneBasedLine int32) string? {
            if string.IsNullOrEmpty(source) || oneBasedLine < 1 {
                return nil
            }
            let lines = source.Replace("\r\n", "\n").Split('\n')
            return if oneBasedLine <= lines.Length {
                lines[oneBasedLine - 1].Trim()
            } else {
                default(string?)
            }
        }

        private func ClassifyGsLine(line string?) string {
            if string.IsNullOrWhiteSpace(line) {
                return "GSharpConstruct"
            }
            // Structural signal (issue #1750): classify on the *leading* token of
            // the statement/declaration only — the syntactic position where a G#
            // keyword actually appears — never on substring content anywhere in
            // the line. Scanning the whole line (the prior `Contains(" for ")`
            // behavior) misclassifies a line like `let msg = "run for cover"` as
            // a `for` construct because the keyword happens to appear inside a
            // string literal; the leading token of that line is `let`, which is
            // unaffected by what the string literal contains.
            // Skip past any leading modifier run (issue #1750 B1) — G# construct
            // lines routinely carry modifiers ahead of the actual construct
            // keyword (`sealed class Shape {`, `async func Bump(...)`,
            // `private func Helper(...)`, `public static func F()`). Matching only
            // the very first token misclassifies every modifier-prefixed
            // construct into the generic bucket, colliding structurally distinct
            // gaps. Walk forward token-by-token — still by syntactic position,
            // never by scanning the whole line — until the token isn't a modifier.
            var remainder = line.TrimStart()
            var leadingToken = LeadingTokenPattern.Match(remainder)
            while leadingToken.Success && ModifierTokens.Contains(leadingToken.Value) {
                remainder = remainder.Substring(leadingToken.Index + leadingToken.Length).TrimStart()
                leadingToken = LeadingTokenPattern.Match(remainder)
            }
            if !leadingToken.Success {
                return "GSharpConstruct"
            }
            let token = leadingToken.Value
            let keywords[]string = []string{
                "func",
                "class",
                "struct",
                "data",
                "interface",
                "enum",
                "let",
                "const",
                "for",
                "foreach",
                "while",
                "if",
                "return",
                "import",
                "package"
            }
            for keyword in keywords {
                if string.Equals(token, keyword, StringComparison.Ordinal) {
                    return char.ToUpperInvariant(keyword[0]) + keyword.Substring(1) + "Construct"
                }
            }
            return "GSharpConstruct"
        }

        private func Truncate(value string?) string? {
            if string.IsNullOrEmpty(value) {
                return value
            }
            let oneLine = value.Replace("\r", " ").Replace("\n", " ").Trim()
            return if oneLine.Length <= SnippetMaxLength {
                oneLine
            } else {
                oneLine.Substring(0, SnippetMaxLength) + "…"
            }
        }

        private func LocationSuffix(line int32?, column int32?) string -> if (line != nil) {
            " ($line${(if (column != nil) { "," + column.ToString() } else { string.Empty })})"
        } else {
            string.Empty
        }
    }
}
