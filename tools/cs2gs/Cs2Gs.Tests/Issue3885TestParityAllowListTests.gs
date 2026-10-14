// <copyright file="Issue3885TestParityAllowListTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3885: the test-parity failure allow-list. An allow-list is a hole in
/// the gate by construction, so every test here exists to prove the hole is
/// small, visible and self-maintaining — and, just as importantly, that the gate
/// still fails everything it failed before.
///
/// The five requirements are proved one test each (and then some):
///
/// 1. granularity — an entry names a test, and a whole-app or whole-class entry is impossible, not
/// merely discouraged;
/// 2. justification — an entry without a real reason fails to load;
/// 3. report, never hide — a pass names its allow-listed failures;
/// 4. staleness — an entry whose test now passes is reported;
/// 5. subset, not intersection — one failure that is NOT on the list still fails the app, whatever else
/// is.
class Issue3885TestParityAllowListTests {
    // ---------------------------------------------------------------------
    // Requirement 1: granularity — individual tests, never apps.
    // ---------------------------------------------------------------------
    /// An entry that names only the app — no `test` at all — is rejected at
    /// load. Allow-listing a whole app would let a genuine regression anywhere
    /// in it pass silently, which is the failure mode that makes allow-lists
    /// dangerous in the first place.
    @Fact
    func WholeAppEntry_IsRejected() {
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
  "reason": "these tests are all coupled to the C# spelling of the repo" } ] }`)
            }
        )
        Assert.Contains("'test' is required", error.Message, StringComparison.Ordinal)
        Assert.Contains("per TEST, never per app", error.Message, StringComparison.Ordinal)
    }

    /// Nor can an entry name many tests by pattern.
    @Fact
    func WildcardEntry_IsRejected() {
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
  "test": "SdkLayoutTests.Sdk_Csproj_*",
  "reason": "these tests are all coupled to the C# spelling of the repo" } ] }`)
            }
        )
        Assert.Contains("must not contain wildcards", error.Message, StringComparison.Ordinal)
    }

    /// A bare method name with no class is ambiguous across an app and is
    /// rejected too: the entry has to be traceable to one declaration.
    @Fact
    func BareMethodNameEntry_IsRejected() {
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
  "test": "Sdk_Csproj_Packs_As_MSBuildSdk",
  "reason": "reads its own repository's csproj by the C# spelling" } ] }`)
            }
        )
        Assert.Contains("at least", error.Message, StringComparison.Ordinal)
        Assert.Contains("Class.Method", error.Message, StringComparison.Ordinal)
    }

    /// The deeper half of requirement 1, and the reason the rule is a MECHANISM
    /// rather than a convention: even an entry that LOOKS valid but names a
    /// namespace or a class matches no test at all, because matching is anchored
    /// at the method. There is no spelling of "allow-list this whole class"
    /// that works, so nobody can reach for one.
    @Fact
    func ClassOrNamespacePrefix_MatchesNothing() {
        let list = TestParityAllowList.Parse(`{
  "entries": [
    { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "GSharp.Sdk.Tests.SdkLayoutTests",
      "reason": "an attempt to allow-list an entire test class in one entry" },
    { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "GSharp.Sdk",
      "reason": "an attempt to allow-list an entire namespace in one entry" }
  ]
}`)
        let verdict = list.Evaluate(SdkTestsAppId, TestParityAllowList.ParseFailedTestNames(SdkTestsOutput))
        Assert.Empty(verdict.AllowedFailures)
        Assert.Equal(3, verdict.UnallowedFailures.Count)
    }

    /// An entry is scoped to ONE app id: the same test name under a different
    /// app is not covered.
    @Fact
    func Entry_DoesNotLeakAcrossApps() {
        let list = TestParityAllowList.Parse(SeededAllowList)
        let verdict = list.Evaluate(
            "test/Core.Tests/Core.Tests.csproj",
            TestParityAllowList.ParseFailedTestNames(SdkTestsOutput)
        )
        Assert.Empty(verdict.AllowedFailures)
        Assert.Equal(3, verdict.UnallowedFailures.Count)
    }

    // ---------------------------------------------------------------------
    // Requirement 2: justification is mandatory.
    // ---------------------------------------------------------------------
    /// An entry with no `reason` fails the whole load. It is not honoured
    /// with a warning and it is not skipped: an unexplained entry is how a list
    /// rots, and the run must stop rather than inherit one.
    @Fact
    func EntryWithoutJustification_IsRejected() {
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
  "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk" } ] }`)
            }
        )
        Assert.Contains("'reason' is required", error.Message, StringComparison.Ordinal)
    }

    /// A placeholder reason is no justification either.
    @Fact
    func PlaceholderJustification_IsRejected() {
        Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
  "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk", "reason": "flaky" } ] }`)
            }
        )
    }

    /// A malformed `issue` reference is rejected, so the traceability the
    /// field exists for cannot quietly decay into free text.
    @Fact
    func MalformedIssueReference_IsRejected() {
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
  "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk",
  "reason": "reads its own repository's csproj by the C# spelling",
  "issue": "see the tracking issue" } ] }`)
            }
        )
        Assert.Contains("'issue' must be", error.Message, StringComparison.Ordinal)
    }

    /// Two entries for the same test in the same app is a merge accident, and a
    /// duplicated entry is one nobody deletes. Rejected.
    @Fact
    func DuplicateEntry_IsRejected() {
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse(`{
  "entries": [
    { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "SdkLayoutTests.A",
      "reason": "reads its own repository's csproj by the C# spelling" },
    { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "SdkLayoutTests.A",
      "reason": "reads its own repository's csproj by the C# spelling" }
  ]
}`)
            }
        )
        Assert.Contains("duplicate entry", error.Message, StringComparison.Ordinal)
    }

    /// A malformed list stops the run rather than degrading to "allow nothing"
    /// (which reads as an unrelated wall of parity failures) or, worse, "allow
    /// everything".
    @Fact
    func MalformedJson_IsRejected() {
        Assert.Throws[InvalidOperationException](
            func () object? {
                return TestParityAllowList.Parse("{ not json")
            }
        )
    }

    /// No file at all means an EMPTY list — every failure fails the app — never
    /// an error and never a permissive default.
    @Fact
    func MissingFile_IsAnEmptyList() {
        let list = TestParityAllowList.LoadOrEmpty(Path.Combine(NewDirectory(), "not-there.json"))
        Assert.Empty(list.Entries!!)
        Assert.Equal(
            3,
            list
                .Evaluate(SdkTestsAppId, TestParityAllowList.ParseFailedTestNames(SdkTestsOutput))
                .UnallowedFailures
                .Count
        )
    }

    // ---------------------------------------------------------------------
    // Requirement 5: subset, not intersection.
    // ---------------------------------------------------------------------
    /// THE load-bearing test. Three allow-listed failures plus ONE that is not
    /// on the list must fail the app — the check is "the failing set is a subset
    /// of the allowed set", never "some failures were allowed".
    @Fact
    func Stage_OneUnlistedFailureAmongAllowedOnes_StillFails() {
        let output = `  Failed GSharp.Sdk.Tests.SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build [14 ms]
  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime [2 ms]
  Failed GSharp.Sdk.Tests.HotReloadDeltaBuilderTests.NewLocalSignature_IsMappedIntoDelta [9 ms]
Failed!  - Failed:     4, Passed:    82, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)`
        let outcome = RunStage(SeededAllowList, output, exitCode: 1, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-FAILED")
    }

    /// The same at list level, so the partition itself is pinned rather than
    /// only its consequence.
    @Fact
    func Evaluate_PartitionsRatherThanForgives() {
        let list = TestParityAllowList.Parse(SeededAllowList)
        let verdict = list.Evaluate(
            SdkTestsAppId,
            List[string]{
                "GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk",
                "GSharp.Sdk.Tests.HotReloadDeltaBuilderTests.NewLocalSignature_IsMappedIntoDelta"
            }
        )
        Assert.Single(verdict.AllowedFailures)
        Assert.Single(verdict.UnallowedFailures)
        Assert.Equal(
            "GSharp.Sdk.Tests.HotReloadDeltaBuilderTests.NewLocalSignature_IsMappedIntoDelta",
            verdict.UnallowedFailures[0]
        )
    }

    /// If the console output does not NAME every failure the run summary counts,
    /// the allow-list is refused outright. Otherwise an unnamed failure — a
    /// truncated log, a crashed reporter — would ride along invisibly on the
    /// named ones.
    @Fact
    func Stage_UnaccountedForFailure_RefusesTheAllowList() {
        let output = `  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
Failed!  - Failed:     7, Passed:    79, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)`
        let outcome = RunStage(SeededAllowList, output, exitCode: 1, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
    }

    // ---------------------------------------------------------------------
    // Requirements 3 and 4, and the before/after for test/Sdk.Tests.
    // ---------------------------------------------------------------------
    /// BEFORE: with no allow-list, the real `test/Sdk.Tests` run is red.
    /// This is the state on `origin/main`, and the state the seeded list is
    /// measured against.
    @Fact
    func Stage_SdkTests_WithoutTheAllowList_IsRed() {
        let outcome = RunStage(allowListJson: nil, output: SdkTestsOutput, exitCode: 1, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-FAILED")
    }

    /// AFTER: with the three entries seeded, the same run is green — and
    /// requirement 3 holds, because the three allow-listed failures are still
    /// NAMED on the context that feeds the run record and the gate summary. A
    /// silent pass would be the dangerous outcome, not the desired one.
    @Fact
    func Stage_SdkTests_WithTheAllowList_IsGreen_AndStillNamesTheFailures() {
        let context = StageContextFixture(SeededAllowList, facts: 86)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context.Context,
            ProcessRunResult(1, SdkTestsOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Empty(outcome.Artifacts)
        Assert.Equal(3, context.Context.AllowedTestFailures.Count)
        Assert.Contains(
            context.Context.AllowedTestFailures,
            (name string) -> name.EndsWith("Sdk_Csproj_Packs_As_MSBuildSdk", StringComparison.Ordinal)
        )
        Assert.Empty(context.Context.StaleTestAllowListEntries)
        let log = context.ReadLog()
        Assert.Contains("ALLOW-LISTED", log, StringComparison.Ordinal)
        Assert.Contains("Sdk_Csproj_Packs_As_MSBuildSdk", log, StringComparison.Ordinal)
    }

    /// The other half of the before/after: REMOVE one entry while its test still
    /// fails and the app goes red again. Without this, "green with the list" is
    /// not evidence that the list is what made it green.
    @Fact
    func Stage_SdkTests_WithOneEntryRemoved_IsRedAgain() {
        // The seeded list minus Sdk_Csproj_Packs_As_MSBuildSdk, whose test still fails.
        let twoEntries = `{
  "entries": [
    {
      "app": "test/Sdk.Tests/Sdk.Tests.csproj",
      "test": "SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build",
      "reason": "Reads its own repository's HotReloadAgent.cs and asserts C# field syntax."
    },
    {
      "app": "test/Sdk.Tests/Sdk.Tests.csproj",
      "test": "SdkLayoutTests.Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime",
      "reason": "Matches a ProjectReference Include ending in .csproj, retargeted to .gsproj."
    }
  ]
}`
        let outcome = RunStage(twoEntries, SdkTestsOutput, exitCode: 1, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-FAILED")
    }

    /// Requirement 4: an entry whose test STARTS PASSING is reported as stale,
    /// mirroring how `greenApps` reports newly-green apps to bank. It is
    /// advisory — the app still passes — because a hard failure would make the
    /// PR that FIXES a test red, which is the wrong incentive to build into a
    /// gate.
    @Fact
    func Stage_AllowListedTestThatNowPasses_IsReportedStale_ButNotFatal() {
        let oneNowPasses = `  Failed GSharp.Sdk.Tests.SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build [14 ms]
  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
Failed!  - Failed:     2, Passed:    84, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)`
        let context = StageContextFixture(SeededAllowList, facts: 86)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context.Context,
            ProcessRunResult(1, oneNowPasses, string.Empty, false)
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Single(context.Context.StaleTestAllowListEntries)
        Assert.Contains(
            "Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime",
            context.Context.StaleTestAllowListEntries[0],
            StringComparison.Ordinal
        )
        Assert.Contains("no longer failing", context.ReadLog(), StringComparison.Ordinal)
    }

    /// Staleness has to be visible on a FULLY green run too, otherwise the only
    /// run that could ever report a stale entry is one that is failing for other
    /// reasons, and the list would never shrink.
    @Fact
    func Stage_FullyGreenRun_StillReportsEveryStaleEntry() {
        let context = StageContextFixture(SeededAllowList, facts: 86)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context.Context,
            ProcessRunResult(
                0,
                "Passed!  - Failed:     0, Passed:    86, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)",
                string.Empty,
                false
            )
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Equal(3, context.Context.StaleTestAllowListEntries.Count)
    }

    // ---------------------------------------------------------------------
    // The #3872 guard must survive the allow-list.
    // ---------------------------------------------------------------------
    /// #3872/#3869: an app whose tests fail to RUN must still fail, whatever is
    /// on the allow-list. An entry excuses a test that ran and failed; it never
    /// excuses a suite that never executed. #3869 found an app passing while
    /// running zero tests — this mechanism must not reopen that door.
    @Fact
    func Stage_ZeroTestsRan_StillFails_WithAFullAllowList() {
        let discoveryFailure = `[xUnit.net 00:00:00.08] Exception discovering tests from Sdk.Tests:
System.TypeLoadException: A ByRef or ByRef-like type cannot be used ...
No test is available in /mirror/Sdk.Tests.dll. Make sure that test discoverer & executors are registered.`
        let outcome = RunStage(SeededAllowList, discoveryFailure, exitCode: 0, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "NO-TESTS-RAN")
    }

    /// The subtler zero-test shape: a completed run that reports only
    /// allow-listed failures but executed FEWER cases than the C# original
    /// declares `[Fact]` methods. The allow-list would otherwise turn a
    /// silent coverage collapse into a green app — exactly #3869's defect, one
    /// mechanism further along.
    @Fact
    func Stage_CoverageDrop_StillFails_EvenWhenEveryReportedFailureIsAllowed() {
        let tinyRun = `  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
Failed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4, Duration: 1 s - Sdk.Tests.dll (net10.0)`
        let outcome = RunStage(SeededAllowList, tinyRun, exitCode: 1, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-FAILED")
    }

    /// A project that did not BUILD is still a build failure, not an
    /// allow-listable set of test failures: there are no per-test outcomes to
    /// allow. The #2867 classification must survive too.
    @Fact
    func Stage_BuildFailure_IsStillABuildFailure() {
        let outcome = RunStage(SeededAllowList, "error GS0102: duplicate definition", exitCode: 1, facts: 86)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-BUILD-FAILED")
    }

    // ---------------------------------------------------------------------
    // Output parsing.
    // ---------------------------------------------------------------------
    /// The run SUMMARY line (`Failed! - Failed: 3, …`) is not a per-test
    /// failure. Counting it as one would inflate the parsed name list past the
    /// reported total and refuse every allow-list.
    @Fact
    func ParseFailedTestNames_IgnoresTheRunSummaryLine() {
        let names = TestParityAllowList.ParseFailedTestNames(SdkTestsOutput)
        Assert.Equal(3, names.Count)
        Assert.All(names, (name string) -> Assert.StartsWith("GSharp.Sdk.Tests.", name, StringComparison.Ordinal))
        Assert.Equal(3, TestParityAllowList.ReportedFailureCount(SdkTestsOutput))
    }

    /// A theory row's arguments are stripped, so one entry covers the test
    /// METHOD rather than one row of its data source.
    @Fact
    func TheoryRows_NormalizeToTheirMethod() {
        Assert.Equal("Ns.C.M", TestParityAllowList.NormalizeTestName("Ns.C.M(value: 1, other: \"x\")"))
        let list = TestParityAllowList.Parse(`{ "entries": [ { "app": "test/X/X.csproj", "test": "C.M",
  "reason": "a theory whose every row asserts the C# spelling of the repo" } ] }`)
        let verdict = list.Evaluate("test/X/X.csproj", List[string]{"Ns.C.M(value: 1)", "Ns.C.M(value: 2)"})
        Assert.Equal(2, verdict.AllowedFailures.Count)
        Assert.Empty(verdict.UnallowedFailures)
    }

    // ---------------------------------------------------------------------
    // The committed file itself.
    // ---------------------------------------------------------------------
    /// The file the gate actually reads must load, and every entry in it must be
    /// well-formed and attributed. It must NOT have grown the defects under
    /// investigation (#3848/#3849 in InternalAnalyzers.Tests /
    /// LanguageServer.Tests / GeneratorHost.Tests) — those are defects, not
    /// policy, and an allow-list that absorbs them stops meaning anything.
    ///
    /// This deliberately does NOT pin a population. It once asserted exactly the
    /// three seeded #3885 entries, and the gate then reported all three as no
    /// longer failing: the mirror became faithful enough for those layout-coupled
    /// assertions to hold, so the entries were removed and this test failed for
    /// doing its job backwards. A policy register's contents are expected to
    /// change; pinning the count makes correctly retiring an entry look like a
    /// regression. What must never change are the INVARIANTS below, and an empty
    /// list is the healthiest state this file can be in.
    @Fact
    func CommittedAllowList_LoadsAndEveryEntryIsWellFormedAndAttributed() {
        let path = Path.Combine(RepoRoot(), TestParityAllowList.DefaultRelativePath)
        Assert.True(File.Exists(path), path)
        // Load validates: it throws on a malformed file or an unjustified entry.
        let list = TestParityAllowList.Load(path)
        Assert.All(
            list.Entries!!,
            (entry TestParityAllowListEntry) -> {
                Assert.False(string.IsNullOrWhiteSpace(entry.App))
                Assert.False(string.IsNullOrWhiteSpace(entry.Test))
                Assert.True(
                    entry.Reason.Length >= TestParityAllowList.MinimumReasonLength,
                    "entry lacks a substantive reason: " + entry.Test
                )
                // Attribution is what makes an entry auditable later.
                Assert.False(string.IsNullOrWhiteSpace(entry.Issue), "entry has no tracking issue: " + entry.Test)
            }
        )
        // One entry, one test. A duplicate is a merge accident, and it would make
        // the stale-entry report ambiguous.
        Assert.DoesNotContain(
            list.Entries!!.GroupBy(
                (entry TestParityAllowListEntry) -> (entry.App + "|" + entry.Test),
                StringComparer.Ordinal
            ),
            (group IGrouping[string, TestParityAllowListEntry]) -> group.Count() > 1
        )
        // The apps whose parity failures are DEFECTS may never appear here. This
        // is the assertion that actually keeps the hole small.
        Assert.DoesNotContain(
            list.Entries!!,
            (entry TestParityAllowListEntry) -> entry.App.Contains(
                "InternalAnalyzers.Tests",
                StringComparison.Ordinal
            ) ||
                entry
                .App
                .Contains("LanguageServer.Tests", StringComparison.Ordinal) || entry.App.Contains(
                "GeneratorHost.Tests",
                StringComparison.Ordinal
            )
        )
    }

    // ---------------------------------------------------------------------
    // Requirement 3, end to end: the verdict survives the shard merge and is
    // printed by the gate.
    // ---------------------------------------------------------------------
    /// The verdict is produced by the validation SHARD that ran stage 4, so it
    /// has to survive `build/merge-selfmig-runs.py`. Dropped here, an
    /// allow-listed pass would be indistinguishable from an unconditional one in
    /// the merged run the gate reads.
    @Fact
    func Merge_CarriesTheAllowListVerdictFromTheShard() {
        let dir = NewDirectory()
        let migratePath = Path.Combine(dir, "migrate.json")
        let shardPath = Path.Combine(dir, "shard.json")
        let outPath = Path.Combine(dir, "merged.json")
        File.WriteAllText(migratePath, `{ "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
  "succeeded": true, "apps": [ { "appId": "test/Sdk.Tests/Sdk.Tests.csproj",
    "succeeded": true, "stages": [ { "stage": "translate", "status": "passed",
    "artifactCount": 0 } ], "artifacts": [], "fingerprints": [] } ] }`)
        File.WriteAllText(shardPath, `{ "runId": "r2", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
  "succeeded": true, "apps": [ { "appId": "test/Sdk.Tests/Sdk.Tests.csproj",
    "succeeded": true, "stages": [ { "stage": "test-parity", "status": "passed",
    "artifactCount": 0 } ], "artifacts": [], "fingerprints": [],
    "allowedTestFailures": [ "GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk" ],
    "staleAllowListEntries": [ "SdkLayoutTests.Gone (test/Sdk.Tests/Sdk.Tests.csproj, #3885)" ] } ] }`)
        let (exit, output) = RunProcess(
            "python3",
            Path.Combine(RepoRoot(), "build", "merge-selfmig-runs.py"),
            "--migrate",
            migratePath,
            "--out",
            outPath,
            shardPath
        )
        Assert.True(exit == 0, output)
        let merged = File.ReadAllText(outPath)
        Assert.Contains("Sdk_Csproj_Packs_As_MSBuildSdk", merged, StringComparison.Ordinal)
        Assert.Contains("SdkLayoutTests.Gone", merged, StringComparison.Ordinal)
    }

    /// And the gate itself must PRINT both halves. A green run that says nothing
    /// about the allow-list is the failure mode this whole design exists to
    /// avoid; a stale entry that nobody is told about is how the list rots.
    /// Staleness is advisory here on purpose — the gate still PASSES — because a
    /// hard failure would make the PR that fixes a test red.
    @Fact
    func Gate_PrintsAllowListedFailuresAndStaleEntries_AndStillPasses() {
        let dir = NewDirectory()
        let runJson = Path.Combine(dir, "run.json")
        let baseline = Path.Combine(dir, "baseline.json")
        File.WriteAllText(runJson, `{ "apps": [ { "appId": "test/Sdk.Tests/Sdk.Tests.csproj",
    "succeeded": true, "unverified": false,
    "stages": [
      { "stage": "translate", "status": "passed" },
      { "stage": "compile", "status": "passed" },
      { "stage": "ilverify", "status": "passed" },
      { "stage": "test-parity", "status": "passed" }
    ],
    "allowedTestFailures": [ "GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk" ],
    "staleAllowListEntries": [ "SdkLayoutTests.Gone (test/Sdk.Tests/Sdk.Tests.csproj, #3885)" ] } ] }`)
        File.WriteAllText(baseline, `{ "greenFloor": 1, "syntheticLabelCeiling": 0, "liftedLocalCeiling": 0,
  "longLineCeiling": 0, "nullAssertionCeiling": 0,
  "greenApps": [ "test/Sdk.Tests/Sdk.Tests.csproj" ] }`)
        let script = Path.Combine(dir, "gate.sh")
        File.WriteAllText(
            script,
            "set -euo pipefail\n" + "source '" + Path.Combine(RepoRoot(), "build", "selfmig-common.sh") +
                "'\n" +
                "labels=0; lifts=0; long_lines=0; bangs=0\n" +
                "selfmig_apply_baseline '" +
                baseline +
                "' 1 1 '" +
                runJson +
                "'\n"
        )
        let (exit, output) = RunProcess("bash", script)
        Assert.True(exit == 0, output)
        Assert.Contains("Self-migration gate PASSED.", output, StringComparison.Ordinal)
        Assert.Contains("allow-listed test-parity failures", output, StringComparison.Ordinal)
        Assert.Contains("Sdk_Csproj_Packs_As_MSBuildSdk", output, StringComparison.Ordinal)
        Assert.Contains("no longer failing", output, StringComparison.Ordinal)
        Assert.Contains("SdkLayoutTests.Gone", output, StringComparison.Ordinal)
    }

    /// A stage context whose C# "original" declares [`facts`](paramref)
    /// `[Fact]` methods, so the #3872 lower bound is real rather than
    /// disabled — a fixture with 0 facts would let a coverage-drop test pass for
    /// the wrong reason.
    private class StageContextFixture {
        private let directory string

        internal init(allowListJson string?, facts int32) {
            this.directory = Issue3885TestParityAllowListTests.NewDirectory()
            let source = StringBuilder()
            source.AppendLine("using Xunit;")
            source.AppendLine("public class Own {")
            for var i = 0; i < facts; i++ {
                source.AppendLine("    [Fact] public void T$i() { }")
            }
            source.AppendLine("}")
            let csPath = Path.Combine(this.directory, "Own.cs")
            File.WriteAllText(csPath, source.ToString())
            let projectPath = Path.Combine(this.directory, "Sdk.Tests.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`)
            let app = CorpusApp(Issue3885TestParityAllowListTests.SdkTestsAppId, projectPath, TargetKind.Library)
            let options = PipelineOptions{
                OutputRoot: this.directory,
                TestParityAllowList: if allowListJson == nil {
                    default(TestParityAllowList?)
                } else {
                    TestParityAllowList.Parse(allowListJson)
                }
            }
            let triage = TriageBuilder("run_1", "2026-09-04T00:00:00Z", "0.0.0", app.Id)
            this.Context = StageExecutionContext(app, options, GscInvoker(FindCompiler()), this.directory, triage)
            this.Context.EmittedFiles.Add(EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty))
        }

        internal prop Context StageExecutionContext {
            get;
        }

        internal func ReadLog() string {
            let log = Path.Combine(this.directory, "test-parity.log")
            return if File.Exists(log) {
                File.ReadAllText(log)
            } else {
                string.Empty
            }
        }

        shared {
            private func FindCompiler() string {
                var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
                while dir != nil {
                    for config in[]string{"Release", "Debug"} {
                        let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                        if File.Exists(candidate) {
                            return candidate
                        }
                    }
                    dir = dir.Parent
                }
                return "gsc.dll"
            }
        }
    }

    shared {
        /// <summary>
        /// The three real #3885 failures as `dotnet test` reports them, verbatim in
        /// shape: three `Failed <name>` lines plus a run summary of 86 cases.
        /// </summary>
        private const SdkTestsOutput string = `Determining projects to restore...
  Failed GSharp.Sdk.Tests.SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build [14 ms]
  Error Message:
   System.IO.FileNotFoundException : /mirror/src/Sdk/Gsharp.HotReload.Runtime/HotReloadAgent.cs
  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
  Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime [2 ms]
Failed!  - Failed:     3, Passed:    83, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)`

        private const SdkTestsAppId string = "test/Sdk.Tests/Sdk.Tests.csproj"

        /// The three seeded entries, exactly as the committed file spells them.
        private const SeededAllowList string = `{
  "schemaVersion": "1.0",
  "entries": [
    {
      "app": "test/Sdk.Tests/Sdk.Tests.csproj",
      "test": "SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build",
      "reason": "Reads its own repository's HotReloadAgent.cs and asserts C# field syntax; the mirror correctly holds HotReloadAgent.gs.",
      "issue": "#3885"
    },
    {
      "app": "test/Sdk.Tests/Sdk.Tests.csproj",
      "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk",
      "reason": "Reads Gsharp.NET.Sdk.csproj by its C# spelling; the mirror correctly holds Gsharp.NET.Sdk.gsproj and no .csproj at all.",
      "issue": "#3885"
    },
    {
      "app": "test/Sdk.Tests/Sdk.Tests.csproj",
      "test": "SdkLayoutTests.Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime",
      "reason": "Matches a ProjectReference Include ending in .csproj, which the mirror correctly retargets to .gsproj.",
      "issue": "#3885"
    }
  ]
}`

        private func RunProcess(fileName string, arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo(fileName){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            let output = process!!.StandardOutput.ReadToEnd() + process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            return (process!!.ExitCode, output)
        }

        private func RunStage(allowListJson string?, output string, exitCode int32, facts int32) StageOutcome {
            let fixture = StageContextFixture(allowListJson, facts)
            return TestParityStage().EvaluateMirroredTestRun(
                fixture.Context,
                ProcessRunResult(exitCode, output, string.Empty, false)
            )
        }

        private func RepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            throw InvalidOperationException("repository root not found from " + AppContext.BaseDirectory)
        }

        private func NewDirectory() string {
            let path = Path.Combine(AppContext.BaseDirectory, "issue-3885-allowlist", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }
    }
}
