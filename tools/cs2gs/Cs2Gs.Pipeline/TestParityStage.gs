// <copyright file="TestParityStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Threading
import System.Threading.Tasks
import System.Xml.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Globalization

/// Stage 4 (ADR-0115 §C/§E): prove the migrated program behaves identically to
/// the original C# against the captured parity oracle. Two modes, selected by
/// the corpus app:
/// - <b>Executable apps with a stdout golden</b> (e.g. L1) → <b>stdout parity</b>: run the stage-2/3
/// emitted assembly (`dotnet <emitted>.dll`), capture stdout, and compare it to
/// `baseline.stdout.golden` (normalizing the trailing newline only). A mismatch yields a
/// `test-parity-failure` artifact (`STDOUT-MISMATCH`).
/// - <b>Library apps with a <c>.Tests</c> oracle</b> (L2/L3) → <b>xUnit pass/fail-set parity</b>:
/// translate the C# `.Tests` project to a G# xUnit project, build it against the locally-built
/// `Gsharp.NET.Sdk`, run `dotnet test`, parse the TRX, and compare the outcome set to
/// `baseline.tests.json`. Any missing/extra/outcome-mismatch test yields a `test-parity-failure`
/// artifact. The library path depends on C#-xUnit-test → G# translation (the <i>map-advanced</i> step);
/// until a test project translates cleanly the stage <b>skips the library path with an explicit,
/// recorded reason</b> rather than fabricating a pass.
/// Runs only after a green stage-3 (it short-circuits with the rest), so L2/L3
/// — which stop at stage 1 today — never reach it until they translate.
partial class TestParityStage : IMigrationStage {
    private let libraryRunner GsharpTestProjectRunner

    /// Initializes a new instance of the (cref:TestParityStage) class.
    /// @param libraryRunner The live library xUnit runner; when `null` a default
    /// runner that discovers the repo root is used.
    init(libraryRunner GsharpTestProjectRunner? = nil) {
        this.libraryRunner = libraryRunner ?? GsharpTestProjectRunner()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Kind MigrationStageKind -> MigrationStageKind.TestParity

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    async func ExecuteAsync(
        context StageExecutionContext?,
        cancellationToken CancellationToken = default(CancellationToken)
    ) StageOutcome {
        if context == nil {
            throw ArgumentNullException("context")
        }
        if IsStdoutEligible(context) {
            return this.RunStdoutParity(context)
        }
        if IsLibraryEligible(context) {
            return await this.RunLibraryParityAsync(context, cancellationToken).ConfigureAwait(false)
        }
        if context
            .Options
            .OutputLayout == MigrationOutputLayout.Repository &&
            IsMirroredTestProject(context.IsTestProject, context.App.ProjectPath) {
            return this.RunMirroredTestProject(context)
        }
        // No parity oracle applies to this app (e.g. an executable with no golden
        // or a library with no `.Tests` baseline): nothing to verify.
        this.Note(context, "no parity oracle (no stdout golden and no .Tests baseline); nothing to verify.")
        return StageOutcome.Passed()
    }

    /// Issue #3869: the verdict half of (cref:RunMirroredTestProject),
    /// split from the process invocation so BOTH directions of the gate — a
    /// hollow run must fail, a genuinely green run must still pass — are
    /// testable at stage-outcome level without shelling out to
    /// `dotnet test`.
    /// @param context The stage context.
    /// @param result The captured `dotnet test` result.
    /// @param budget Issue #3501: the budget the run was ACTUALLY given, threaded through
    /// from (cref:RunMirroredTestProject) so the timeout diagnostic
    /// quotes the number the killed process was held to rather than a second
    /// opinion computed after the fact. `null` (the shape unit
    /// tests use) recomputes it from the same inputs, which is the same value.
    /// @returns The stage outcome.
    internal func EvaluateMirroredTestRun(
        context StageExecutionContext,
        result ProcessRunResult,
        budget TimeSpan? = nil
    ) StageOutcome {
        this.Note(context, result.Output ?? string.Empty)
        let allowList = context.Options.TestParityAllowList ?? TestParityAllowList.Empty
        if result.ExitCode == 0 {
            // Issue #3869: exit code 0 is NOT evidence that tests ran. `dotnet
            // test` exits 0 when it discovers nothing, so a migrated assembly
            // that cannot be enumerated at all scored a full green here. Require
            // positive evidence instead: a completed run, a non-zero executed
            // count, and no silent drop against the C# original's [Fact] count.
            let minimumExpected = CountCSharpFactMethods(context)
            let hollow string? = DescribeHollowTestRun(result.Output ?? string.Empty, minimumExpected)
            // Issue #4633: the count is a floor, not parity. Every case the C#
            // original discovers must have run, and nothing else. Checked (and
            // recorded) whether or not the floor held, so every exit-0 run has
            // a per-name summary in the run record.
            let namesDiffer TriageArtifact? = this.CheckTestNames(context)
            if hollow == nil {
                let ranNote = "mirrored test run: ${ExecutedTestCount(result.Output)} case(s) executed " +
                    "(>= $minimumExpected expected from the C# original's [Fact] methods)."
                this.Note(context, ranNote)
                if namesDiffer != nil {
                    return StageOutcome.Failed([]TriageArtifact{namesDiffer})
                }
                // Issue #3885: an app whose tests ALL pass still has to answer
                // for its allow-list entries. Without this, the only run in
                // which a stale entry could surface is one that is failing for
                // other reasons — and the list would never shrink.
                this.RecordAllowList(context, allowList.Evaluate(context.App.Id, Array.Empty[string]()))
                return StageOutcome.Passed()
            }
            this.Note(context, "mirrored test-parity FAILED: " + hollow)
            let hollowFailures = List[TriageArtifact]{
                context.Triage.TestParityNoTestsRan(hollow, result.Output ?? string.Empty, EmittedGsRelative(context))
            }
            if namesDiffer != nil {
                hollowFailures.Add(namesDiffer)
            }
            return StageOutcome.Failed(hollowFailures)
        }
        // Issue #2867: a non-zero `dotnet test` exit means EITHER the project
        // failed to build OR it built, ran, and the tests failed. Only the
        // former is a translator/SDK regression; conflating them sends triage
        // after the emitter when the real signal is a runtime failure, and
        // discards the per-test outcomes.
        let output = result.Output ?? "dotnet test failed without output."
        // Issue #3931: a run KILLED on the wall-clock budget is a third
        // outcome, and it looked exactly like the first — no summary line, so
        // `CompletedTestRun` is false and it was filed as a build failure.
        // That made a hang indistinguishable from a translator regression, and
        // (worse) let the truncated `[FAIL]` list be read as a parity count
        // when it is only "the failures that happened before the kill". Name
        // the timeout for what it is, ahead of both other classifications.
        if result.TimedOut {
            // Issue #3501: the budget is per-app now, so the diagnostic must
            // name THIS app's budget. #3931's whole point was that the message
            // says which number was exceeded; a message quoting a global
            // constant the run was never held to would be worse than the
            // nameless timeout it replaced.
            let timeout = budget ?? MirroredTestRunBudgetFor(context)
            return StageOutcome.Failed(
                []TriageArtifact{
                    context.Triage.TestParityLibraryTestRunTimedOut(timeout, output, EmittedGsRelative(context))
                }
            )
        }
        if !CompletedTestRun(output) {
            return StageOutcome.Failed(
                []TriageArtifact{context.Triage.TestParityLibraryBuildFailure(output, EmittedGsRelative(context))}
            )
        }
        // Issue #4633: a completed run with failures is still compared name for
        // name. An allow-list excuses a failing case, never a missing one, and a
        // red app's name differences are reported alongside its failures.
        let nameMismatch TriageArtifact? = this.CheckTestNames(context)
        if this.AllowListAbsolves(context, allowList, output) {
            return if nameMismatch == nil {
                StageOutcome.Passed()
            } else {
                StageOutcome.Failed([]TriageArtifact{nameMismatch})
            }
        }
        let failures = List[TriageArtifact]{
            context.Triage.TestParityLibraryTestFailure(output, EmittedGsRelative(context))
        }
        if nameMismatch != nil {
            failures.Add(nameMismatch)
        }
        return StageOutcome.Failed(failures)
    }

    /// Issue #3885: whether every failure this completed run reported is on the
    /// allow-list, in which case the app is green despite a non-zero
    /// `dotnet test` exit.
    ///
    /// The bar is deliberately higher than "the names I could parse are all
    /// allowed". Three things must hold together, and each guards a way this
    /// mechanism could quietly become a licence to pass:
    ///
    /// 1. The parsed failure names must ACCOUNT FOR every failure the run summary counts. If the console
    /// output names fewer failures than `Failed: N` reports, some failure is unaccounted for and could be
    /// anything; the allow-list is refused rather than trusted.
    /// 2. The unallowed set must be EMPTY. "Some failures were allowed" is not the test; "the failing set
    /// is a subset of the allowed set" is.
    /// 3. The #3872/#3869 evidence that tests actually RAN still applies verbatim. An allow-list entry
    /// excuses a test that fails, never a suite that never executed: an app running zero tests fails
    /// whatever is on the list.
    /// @param context The stage context.
    /// @param allowList The loaded allow-list.
    /// @param output The captured `dotnet test` output of a completed run.
    /// @returns `true` when the app may be reported green.
    private func AllowListAbsolves(context StageExecutionContext, allowList TestParityAllowList, output string) bool {
        let failed = TestParityAllowList.ParseFailedTestNames(output)
        let verdict = allowList.Evaluate(context.App.Id, failed)
        this.RecordAllowList(context, verdict)
        if verdict.AllowedFailures.Count == 0 {
            return false
        }
        let reported = TestParityAllowList.ReportedFailureCount(output)
        if failed.Count != reported {
            let unaccounted = "test-parity allow-list REFUSED: parsed ${failed.Count} per-test failure name(s) " +
                "but the run summary reports $reported failure(s). An unaccounted-for failure " +
                "could be anything, so the app fails (#3885)."
            this.Note(context, unaccounted)
            return false
        }
        if verdict.UnallowedFailures.Count > 0 {
            let unlisted = string.Join(Environment.NewLine + "  ", verdict.UnallowedFailures)
            let header = "test-parity allow-list NOT APPLIED — " +
                "${verdict.UnallowedFailures.Count} failure(s) are not on the list (#3885):"
            this.Note(context, header + Environment.NewLine + "  " + unlisted)
            return false
        }
        // The #3872 guard is NOT waived by an allow-list. A suite that failed to
        // run its tests must still fail even when the failures it did report are
        // all allowed.
        let minimumExpected = CountCSharpFactMethods(context)
        let hollow string? = DescribeHollowTestRun(output, minimumExpected)
        if hollow != nil {
            let neverRan = "test-parity allow-list REFUSED: the run does not show tests actually " +
                "executing, which an allow-list never waives (#3872/#3869): " +
                hollow
            this.Note(context, neverRan)
            return false
        }
        let passedNote = "mirrored test-parity PASSED with ${verdict.AllowedFailures.Count} ALLOW-LISTED " +
            "failure(s) and no others; ${ExecutedTestCount(output)} case(s) executed " +
            "(>= $minimumExpected expected from the C# original's [Fact] methods) (#3885)."
        this.Note(context, passedNote)
        return true
    }

    /// Issue #3885 requirement 3 — report, never hide. Both halves of the
    /// verdict are written to the stage log AND published on the context so the
    /// run record (and through it the gate summary) names every allow-listed
    /// failure that occurred, and every entry that no longer fires.
    /// @param context The stage context.
    /// @param verdict The allow-list verdict.
    private func RecordAllowList(context StageExecutionContext, verdict TestParityAllowListVerdict) {
        for allowed in verdict.AllowedFailures {
            context.AllowedTestFailures.Add(allowed)
            this.Note(context, "test-parity allow-listed failure: " + allowed)
        }
        for stale in verdict.StaleEntries {
            // Advisory, never fatal (see TestParityAllowListVerdict.StaleEntries):
            // a hard failure here would make the PR that FIXES a test red.
            context.StaleTestAllowListEntries.Add(stale.ToString())
            let staleNote = "test-parity allow-list entry is STALE — no longer failing, remove from the " +
                "allow-list: " +
                stale.ToString()
            this.Note(context, staleNote)
        }
    }

    private func RunMirroredTestProject(context StageExecutionContext) StageOutcome {
        let generatedProject = context.Options.GeneratedProjectPaths!![Path.GetFullPath(context.App.ProjectPath)]
        // Issue #3501: record the sizing as well as the verdict. A budget that
        // is no longer a constant has to be visible in the run log, or the next
        // reader of a timeout cannot tell whether the app was starved or stuck.
        let declaredTests = CountCSharpFactMethods(context)
        let budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declaredTests)
        let budgetNote = "mirrored test run budget: $budget for $declaredTests declared " +
            "[Fact] method(s) in the C# original (#3501)."
        this.Note(context, budgetNote)
        let result = SdkCompileRunner.TestMirroredProject(
            generatedProject,
            context.ArtifactDir,
            context.Options.Config,
            context.Options.GeneratedProjectPaths,
            context.Options.SourceRoot,
            budget
        )
        return this.EvaluateMirroredTestRun(context, result, budget)
    }

    private func RunStdoutParity(context StageExecutionContext) StageOutcome {
        let (exit, stdout, stderr, timedOut) = RunProgram(context.EmittedAssemblyPath, context.ProjectOutputDir)
        let parity = StdoutParity.CompareFile(context.App.StdoutGolden, stdout)
        let note = "stdout parity: exit=$exit; match=${parity.IsMatch}; timedOut=$timedOut." +
            (
            if parity.IsMatch {
                string.Empty
            } else {
                " " + parity.Describe()
            }
        ) +
            (
            if string.IsNullOrWhiteSpace(stderr) {
                string.Empty
            } else {
                `
stderr:
` + stderr
            }
        )
        this.Note(context, note)
        if timedOut {
            // A codegen bug producing an infinite loop must surface as a named
            // parity failure, not an unattended-CI hang (#1748).
            let timeoutDiff = StdoutParityResult.Mismatch(0, "process to complete", "process timed out")
            let timeoutArtifact = context.Triage.TestParityStdoutFailure(timeoutDiff, EmittedGsRelative(context))
            return StageOutcome.Failed([]TriageArtifact{timeoutArtifact})
        }
        if parity.IsMatch && exit == 0 {
            return StageOutcome.Passed()
        }
        if parity.IsMatch && exit != 0 {
            // Output matched but the process exited non-zero — still a behavioral
            // divergence from the (green) C# baseline. Report it as a stdout-shape
            // failure carrying the exit code.
            let exitDiff = StdoutParityResult.Mismatch(0, "exit code 0", "exit code " + exit.ToString())
            let exitArtifact = context.Triage.TestParityStdoutFailure(exitDiff, EmittedGsRelative(context))
            return StageOutcome.Failed([]TriageArtifact{exitArtifact})
        }
        let artifact = context.Triage.TestParityStdoutFailure(parity, EmittedGsRelative(context))
        return StageOutcome.Failed([]TriageArtifact{artifact})
    }

    private async func RunLibraryParityAsync(
        context StageExecutionContext,
        cancellationToken CancellationToken
    ) StageOutcome {
        // Translate the C# `.Tests` project to G#. Until C#-xUnit-test → G#
        // translation (map-advanced) is complete, an unsupported construct or a
        // round-trip failure means the live library path cannot run yet; the
        // stage records the reason and skips rather than fabricating a pass.
        let tests = await TranslateProjectAsync(context.App.TestsProjectPath, cancellationToken).ConfigureAwait(false)
        if tests.LoadErrors != nil {
            this.Note(context, "library xUnit parity FAILED: .Tests project did not load.")
            let loadArtifact = context.Triage.ProjectLoadFailure(
                MigrationStageKind.TestParity,
                TriageCategory.TestParityFailure,
                tests.LoadErrors
            )
            return StageOutcome.Failed([]TriageArtifact{loadArtifact})
        }
        // Issue #2321: a benign NuGet audit vulnerability advisory (CS2GS0003)
        // never fails the .Tests project load above, but must not be dropped
        // silently either — record it regardless of whether translation below
        // is Ready or (still) Pending.
        for advisory in tests.AdvisoryDiagnostics {
            this.Note(
                context,
                "NuGet audit advisory (CS2GS0003, non-fatal) in .Tests project: " + advisory.GetMessage()
            )
        }
        if tests.PendingReason != nil {
            // Gated intentionally (ADR-0115 §E) until test-translation lands —
            // "not verified yet", never a fabricated pass (issue #1749).
            this.Note(context, "library xUnit parity SKIPPED: " + tests.PendingReason)
            return StageOutcome.Skipped()
        }
        let oracle BaselineTestsOracle? = BaselineTestsOracle.Load(context.App.TestsBaselinePath)
        let libraryName = if context.Options.OutputLayout == MigrationOutputLayout.Repository {
            Path.GetFileNameWithoutExtension(context.App.ProjectPath)
        } else {
            MigrationPipeline.SanitizeAppId(context.App.Id).Replace("corpus_", string.Empty)
        }
        let project = GsharpTestProject{
            LibraryName: libraryName,
            LibraryRootNamespace: libraryName.Replace('-', '_'),
            LibraryFiles: context
                .EmittedFiles
                .Select((f EmittedGsFile) -> GsharpSourceFile(Path.GetFileName(f.GsPath), f.GSharpSource))
                .ToList(),
            LibraryFriendAssemblies: if context.Options.OutputLayout == MigrationOutputLayout.Repository {
                cast[IReadOnlyList[string]](
                    context.GeneratedFriendAssemblies.OrderBy((name string) -> name, StringComparer.Ordinal).ToList()
                )
            } else {
                cast[IReadOnlyList[string]](Array.Empty[string]())
            },
            TestsName: libraryName + ".Tests",
            TestsRootNamespace: libraryName.Replace('-', '_') + ".Tests",
            TestFiles: tests.Files,
            SdkVersion: context
                .Options
                .RepositorySdkVersion ??
                (
                if context.Options.OutputLayout == MigrationOutputLayout.Repository {
                    context.Options.SdkVersion
                } else {
                    default(string?)
                }
            )
        }
        let workDir = Path.Combine(context.ArtifactDir, "test-parity")
        let run = this.libraryRunner.Run(project, workDir)
        if run.Status == GsharpTestRunStatus.Unavailable {
            // The SDK/tooling this verification needs is genuinely absent (no
            // locally-built Gsharp.NET.Sdk nupkg) — "not verified", not a pass
            // (issue #1749 mode 1).
            this.Note(context, "library xUnit parity SKIPPED: " + run.UnavailableReason)
            return StageOutcome.Skipped()
        }
        if run.Status == GsharpTestRunStatus.BuildFailed {
            // A library that green-built standalone `gsc` in stage 2 but fails
            // to build its translated G# test project here is a real
            // regression, not "translation pending" — report it as a failure
            // (issue #1749 mode 1), never a fabricated pass.
            let buildNote = "library xUnit parity FAILED: the translated G# test project did not build.\n" +
                Truncate(run.Output)
            this.Note(context, buildNote)
            let buildArtifact = context.Triage.TestParityLibraryBuildFailure(run.Output, EmittedGsRelative(context))
            return StageOutcome.Failed([]TriageArtifact{buildArtifact})
        }
        let parity = TestParityComparison.Compare(oracle!!.Tests, run.Results)
        let parityNote = "library xUnit parity: ${run.Results.Count} ran vs ${oracle!!.Tests!!.Count} baseline; " +
            "match=${parity.IsMatch}; diffs=${parity.Differences.Count}."
        this.Note(context, parityNote)
        if parity.IsMatch {
            return StageOutcome.Passed()
        }
        let gsFile string? = if tests.Files.Count > 0 {
            project.TestsName + "/" + tests.Files[0].FileName
        } else {
            default(string?)
        }
        let artifacts = parity
            .Differences
            .Select((diff TestParityDiff) -> context.Triage.TestParityTestFailure(diff, gsFile))
            .ToList()
        return StageOutcome.Failed(artifacts)
    }

    private func Note(context StageExecutionContext, message string) {
        try {
            File.AppendAllText(Path.Combine(context.ArtifactDir, "test-parity.log"), message + Environment.NewLine)
        } catch (IOException) {
            // A best-effort diagnostic log; never fail the stage on a log write.

        }
    }

    private class TranslatedProject {
        private init(
            files IReadOnlyList[GsharpSourceFile],
            pendingReason string?,
            loadErrors IReadOnlyList[Diagnostic]?,
            advisoryDiagnostics IReadOnlyList[Diagnostic]?
        ) {
            this.Files = files ?? Array.Empty[GsharpSourceFile]()
            this.PendingReason = pendingReason
            this.LoadErrors = loadErrors
            this.AdvisoryDiagnostics = advisoryDiagnostics ?? Array.Empty[Diagnostic]()
        }

        prop Files IReadOnlyList[GsharpSourceFile] {
            get;
        }

        prop PendingReason string? {
            get;
        }

        /// Gets the load-error diagnostics, or `null` if the project bound.
        prop LoadErrors IReadOnlyList[Diagnostic]? {
            get;
        }

        /// Gets the benign NuGet audit vulnerability advisories (issue #2321,
        /// (cref:CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId),
        /// CS2GS0003) MSBuildWorkspace reported while opening this project.
        /// Always empty for a (cref:LoadFailed) project.
        prop AdvisoryDiagnostics IReadOnlyList[Diagnostic] {
            get;
        }

        shared {
            func Ready(
                files IReadOnlyList[GsharpSourceFile],
                advisoryDiagnostics IReadOnlyList[Diagnostic]
            ) TranslatedProject -> TranslatedProject(files, nil, nil, advisoryDiagnostics)

            func Pending(
                reason string,
                advisoryDiagnostics IReadOnlyList[Diagnostic]
            ) TranslatedProject -> TranslatedProject(Array.Empty[GsharpSourceFile](), reason, nil, advisoryDiagnostics)

            func LoadFailed(loadErrors IReadOnlyList[Diagnostic]) TranslatedProject -> TranslatedProject(
                Array.Empty[GsharpSourceFile](),
                nil,
                loadErrors,
                nil
            )
        }
    }

    shared {
        /// Issue #3869: the number of test cases the VSTest run summary reports as
        /// having actually EXECUTED, summed across every summary line (one per
        /// target framework / test assembly), or `null` when the
        /// output carries no run summary at all — i.e. no test run ever happened.
        /// @param output The captured `dotnet test` output.
        /// @returns The executed test-case total, or `null` if no run summary is present.
        internal func ExecutedTestCount(output string) int32? {
            if string.IsNullOrEmpty(output) {
                return nil
            }
            let matches = Regex.Matches(
                output,
                "^\\s*(?:Passed|Failed)!\\s+-\\s+Failed:.*?\\bTotal:\\s*(\\d+)",
                RegexOptions.Multiline | RegexOptions.CultureInvariant
            )
            if matches.Count == 0 {
                return nil
            }
            var total = 0
            for match Match in matches {
                total += int32.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture)
            }
            return total
        }

        /// Issue #3869: decides whether an exit-code-0 `dotnet test` run on a
        /// mirrored test project is genuinely green.
        ///
        /// `dotnet test` exits <b>0</b> when it discovers no tests at all — so
        /// an assembly that cannot even be enumerated (e.g. a
        /// `TypeLoadException` out of `GetExportedTypes()`, as when a
        /// translator drops the `ref` from a `ref struct`) reports
        /// "test-parity PASS" while running ZERO tests. Passing on the exit code
        /// alone makes every future assembly-discovery defect turn the whole app
        /// green: the #1831 class, one stage further along.
        ///
        /// A green mirrored run must therefore show positive evidence that tests
        /// RAN: a VSTest run summary, a non-zero executed count, and — so a
        /// <i>silent</i> coverage drop is caught too — at least as many executed
        /// cases as the original C# project has `[Fact]`-attributed test
        /// methods. Only `[Fact]` is counted (never `[Theory]`, whose row
        /// count is a runtime property of its data source), which makes
        /// [`minimumExpected`](paramref) a sound lower bound on the number of
        /// discovered cases rather than a tuned threshold.
        /// @param output The captured `dotnet test` output.
        /// @param minimumExpected The lower bound on executed cases derived from the original C# sources
        /// (see (cref:CountCSharpFactMethods)); 0 disables the comparison.
        /// @returns `null` when the run is genuinely green, otherwise the
        /// human-readable reason it is not.
        internal func DescribeHollowTestRun(output string, minimumExpected int32) string? {
            let executed = ExecutedTestCount(output)
            if executed == nil {
                return "NO-TESTS-RAN: `dotnet test` exited 0 but produced no VSTest run summary — " +
                    "no test run completed. `dotnet test` exits 0 when it discovers nothing " +
                    "(e.g. the migrated assembly fails to type-load and xunit enumerates no types), " +
                    "so exit code 0 alone is not evidence of a passing suite (#3869)."
            }
            if executed == 0 {
                return "NO-TESTS-RAN: `dotnet test` exited 0 having executed 0 test cases. " +
                    "A zero-test run is not a pass (#3869)."
            }
            if minimumExpected > 0 && executed < minimumExpected {
                return "TEST-COVERAGE-DROP: only ${executed} test case(s) executed, but the " +
                    "original C# project declares $minimumExpected [Fact] test method(s) — each of " +
                    "which is exactly one test case. Tests were silently lost between the C# original " +
                    "and the migrated assembly (#3869)."
            }
            return nil
        }

        /// Issue #3869: counts the `[Fact]`-attributed test methods declared by
        /// the ORIGINAL C# sources of this app — the authoritative lower bound on how
        /// many test cases the migrated assembly must run. The inputs are the exact
        /// C# files the translator consumed for THIS project
        /// ((cref:EmittedGsFile.CsFilePath), excluding files pulled in from a
        /// referenced project), so the count can never drift from what was migrated.
        ///
        /// Only `[Fact]` methods in `public`, concrete, non-generic,
        /// non-static types are counted (see (cref:IsDiscoverableTestClass)):
        /// a `[Theory]`'s case count is a property of its data source, xunit
        /// does not discover non-public test classes, an abstract type contributes
        /// cases only through its derivations, and a generic test class only through
        /// its closures — counting any of those would make the bound unsound and
        /// manufacture false failures on legitimately green apps.
        /// @param context The stage context.
        /// @returns The number of `[Fact]` test methods, or 0 when none can be determined.
        internal func CountCSharpFactMethods(context StageExecutionContext) int32 {
            let counted = HashSet[string](StringComparer.OrdinalIgnoreCase)
            var facts = 0
            for file in context.EmittedFiles {
                if file.IsFromReferencedProject || string.IsNullOrEmpty(file.CsFilePath) || !counted.Add(
                    file.CsFilePath!!
                ) ||
                    (file.GeneratedSource == nil && !File.Exists(file.CsFilePath)) {
                    continue
                }
                var source string
                try {
                    source = file.GeneratedSource?.Text ?? File.ReadAllText(file.CsFilePath!!)
                } catch (IOException) {
                    // The bound is best-effort evidence, never a reason to crash the
                    // stage: an unreadable input simply contributes nothing.
                    continue
                }
                facts += CountFactMethods(source)
            }
            return facts
        }

        private func CountFactMethods(source string) int32 {
            let root = SyntaxFactory.ParseCompilationUnit(source)
            return root
                .DescendantNodes()
                .OfType[MethodDeclarationSyntax]()
                .Count(
                (method MethodDeclarationSyntax) -> HasFactAttribute(method) &&
                    method
                    .Ancestors()
                    .OfType[TypeDeclarationSyntax]()
                    .All(IsDiscoverableTestClass)
            )
        }

        /// Whether a containing type declaration can itself host xunit-discoverable
        /// test cases. Every condition here EXCLUDES cases from the bound, never adds
        /// them: xunit only discovers tests on `public` classes, an abstract
        /// type contributes cases only through its derivations, and a generic test
        /// class only through its closures. Anything uncertain is left uncounted so
        /// the bound stays a bound.
        private func IsDiscoverableTestClass(type TypeDeclarationSyntax) bool -> type.TypeParameterList == nil &&
            type
            .Modifiers
            .Any((m SyntaxToken) -> m.IsKind(SyntaxKind.PublicKeyword)) && !type.Modifiers.Any(
            (m SyntaxToken) -> m.IsKind(SyntaxKind.AbstractKeyword)
        ) &&
            !type
            .Modifiers
            .Any((m SyntaxToken) -> m.IsKind(SyntaxKind.StaticKeyword))

        private func HasFactAttribute(method MethodDeclarationSyntax) bool -> method
            .AttributeLists
            .SelectMany(
            func (list AttributeListSyntax) IEnumerable[AttributeSyntax] {
                return list.Attributes
            }
        )
            .Select((attribute AttributeSyntax) -> attribute.Name.ToString())
            .Select(
            (name string) -> if name.Contains('.') {
                name.Substring(name.LastIndexOf('.') + 1)
            } else {
                name
            }
        )
            .Any(
            (name string) -> string.Equals(name, "Fact", StringComparison.Ordinal) || string.Equals(
                name,
                "FactAttribute",
                StringComparison.Ordinal
            )
        )

        private func IsStdoutEligible(context StageExecutionContext) bool -> context
            .App
            .TargetKind == TargetKind.Exe &&
            !string.IsNullOrEmpty(context.App.StdoutGolden) && File.Exists(context.App.StdoutGolden) &&
            !string.IsNullOrEmpty(context.EmittedAssemblyPath) && File.Exists(context.EmittedAssemblyPath)

        private func IsLibraryEligible(context StageExecutionContext) bool -> !string.IsNullOrEmpty(
            context.App.TestsProjectPath
        ) &&
            File.Exists(context.App.TestsProjectPath) && !string.IsNullOrEmpty(context.App.TestsBaselinePath) &&
            File.Exists(context.App.TestsBaselinePath)

        /// Issue #3501: this app's mirrored-test budget, derived from the number of
        /// `[Fact]` methods its C# original declares. A single expression so
        /// the budget the run is given and the budget a killed run reports can
        /// never be computed two different ways.
        /// @param context The stage context.
        /// @returns The wall-clock budget for this app's mirrored test run.
        private func MirroredTestRunBudgetFor(
            context StageExecutionContext
        ) TimeSpan -> SdkCompileRunner.MirroredTestRunTimeoutFor(CountCSharpFactMethods(context))

        private func IsTestProject(projectPath string) bool {
            let project = XDocument.Load(projectPath)
            let declaredTestProject = project
                .Descendants()
                .Where(
                (element XElement) -> element.Name.LocalName.Equals("IsTestProject", StringComparison.OrdinalIgnoreCase)
            )
                .Any(
                (element XElement) -> string.Equals(element.Value.Trim(), "true", StringComparison.OrdinalIgnoreCase)
            )
            let testPackage = project
                .Descendants()
                .Where(
                (element XElement) -> element
                    .Name
                    .LocalName
                    .Equals("PackageReference", StringComparison.OrdinalIgnoreCase)
            )
                .Select(
                (element XElement) -> element
                    .Attributes()
                    .FirstOrDefault(
                    (attribute XAttribute) -> attribute
                        .Name
                        .LocalName
                        .Equals("Include", StringComparison.OrdinalIgnoreCase)
                )
                    ?.Value
            )
                .Any(
                ($package string) -> string.Equals(
                    $package,
                    "Microsoft.NET.Test.Sdk",
                    StringComparison.OrdinalIgnoreCase
                )
            )
            let projectName = Path.GetFileNameWithoutExtension(projectPath)
            let segments = Path.GetFullPath(projectPath).Split(
                []char{Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar},
                StringSplitOptions.RemoveEmptyEntries
            )
            return declaredTestProject || testPackage || projectName.EndsWith(
                ".Tests",
                StringComparison.OrdinalIgnoreCase
            ) ||
                projectName.EndsWith(".Test", StringComparison.OrdinalIgnoreCase) || segments.Any(
                (segment string) -> segment.Equals("tests", StringComparison.OrdinalIgnoreCase) || segment.Equals(
                    "test",
                    StringComparison.OrdinalIgnoreCase
                )
            )
        }

        private async func TranslateProjectAsync(
            projectPath string?,
            cancellationToken CancellationToken
        ) TranslatedProject {
            let project = (
                await CSharpProjectLoader.LoadProjectAsync(projectPath, cancellationToken).ConfigureAwait(false)
            )
            // Issue #1742: same load-failure gate as TranslateStage, scoped to the
            // MSBuild workspace load failure signal (not every C# semantic error —
            // some corpus fixtures deliberately carry those to exercise a later
            // stage). A `.Tests` project that does not bind in C# must fail the
            // stage, not be silently skipped as "translation pending" nor proceed
            // to translate.
            if project.WorkspaceLoadFailed {
                return TranslatedProject.LoadFailed(project.WorkspaceLoadErrors)
            }
            // Issue #2321: a benign NuGet audit vulnerability advisory (CS2GS0003)
            // does not fail the workspace load gate above; carry it forward to the
            // caller so it can be recorded (not silently dropped) regardless of
            // whether translation below ends up Ready or Pending.
            let advisoryDiagnostics = project
                .LoadDiagnostics
                .Where((d Diagnostic) -> d.Id == CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId)
                .ToList()
            let files = List[GsharpSourceFile]()
            let usedGsFileNames = HashSet[string](StringComparer.OrdinalIgnoreCase)
            // Issue #2292: ONE translator instance shared across every document in
            // this project (rather than a fresh one per file) so its package-scoped
            // anonymous-type registry (see `CSharpToGSharpTranslator.
            // anonymousTypeRegistriesByPackage`) is shared too — otherwise two
            // files in the same package could each mint a colliding
            // `AnonymousTypeN` name for two DIFFERENT anonymous shapes (GS0102).
            let translator = CSharpToGSharpTranslator(preservePartialParts: true)
            for document in project.Documents {
                cancellationToken.ThrowIfCancellationRequested()
                let translationContext = TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath
                )
                let unit = translator.TranslateDocument(document, translationContext)
                let printed = GSharpPrinter.Print(unit)
                let unsupported TranslationDiagnostic? = translationContext.Diagnostics.FirstOrDefault(
                    (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
                )
                if unsupported != nil {
                    return TranslatedProject.Pending(
                        "test-translation pending map-advanced — unsupported C# construct " +
                            "'${unsupported.ConstructKind}' in ${Path.GetFileName(document.FilePath)}: ${unsupported.Message}",
                        advisoryDiagnostics
                    )
                }
                let roundTrip = GSharpRoundTrip.Validate(printed)
                if !roundTrip.Success {
                    return TranslatedProject.Pending(
                        "test-translation pending map-advanced — emitted G# for " +
                            "${Path.GetFileName(document.FilePath)} did not round-trip-parse: " +
                            (roundTrip.Errors.FirstOrDefault() ?? "unknown parse error"),
                        advisoryDiagnostics
                    )
                }
                let gsFileName = EmittedFileNaming.UniqueGsFileName(document.FilePath, usedGsFileNames)
                files.Add(GsharpSourceFile(gsFileName, printed))
            }
            return TranslatedProject.Ready(files, advisoryDiagnostics)
        }

        private func RunProgram(assemblyPath string?, workingDirectory string)(
            Exit int32,
            Stdout string,
            Stderr string,
            TimedOut bool
        ) {
            // The migrated program under test is exactly the code stage 4 exists to
            // scrutinize: a codegen bug can produce an infinite loop, and a
            // translated Console.ReadLine() would otherwise block on inherited
            // stdin. ProcessRunner bounds the run and never inherits stdin (#1748).
            let result = ProcessRunner.Run("dotnet", []string{assemblyPath!!}, workingDirectory, Stage4Timeout())
            return (result.ExitCode, result.Stdout, result.Stderr, result.TimedOut)
        }

        /// The stage-4 program-under-test timeout, 30s by default. A legit slow
        /// migrated program on a cold/constrained CI runner can false-positive
        /// against a fixed 30s, so allow an override via
        /// `CS2GS_STAGE4_TIMEOUT_SEC` (#1817 S1).
        private func Stage4Timeout() TimeSpan {
            let env string? = Environment.GetEnvironmentVariable("CS2GS_STAGE4_TIMEOUT_SEC")
            return if int32.TryParse(env, out var seconds) && seconds > 0 {
                TimeSpan.FromSeconds(seconds)
            } else {
                TimeSpan.FromSeconds(30)
            }
        }

        private func EmittedGsRelative(context StageExecutionContext) string? -> if context.EmittedFiles.Count > 0 {
            context.EmittedFiles[0].RelativeGsPath
        } else {
            default(string?)
        }

        private func Truncate(value string) string {
            if string.IsNullOrEmpty(value) {
                return string.Empty
            }
            let trimmed = value.Trim()
            return if trimmed.Length <= 2000 {
                trimmed
            } else {
                trimmed.Substring(trimmed.Length - 2000)
            }
        }
    }
}
