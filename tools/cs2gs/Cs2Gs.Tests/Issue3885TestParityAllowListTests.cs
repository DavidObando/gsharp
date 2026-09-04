// <copyright file="Issue3885TestParityAllowListTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3885: the test-parity failure allow-list. An allow-list is a hole in
/// the gate by construction, so every test here exists to prove the hole is
/// small, visible and self-maintaining — and, just as importantly, that the gate
/// still fails everything it failed before.
/// <para>
/// The five requirements are proved one test each (and then some):
/// </para>
/// <list type="number">
/// <item><description>granularity — an entry names a test, and a whole-app or
/// whole-class entry is impossible, not merely discouraged;</description></item>
/// <item><description>justification — an entry without a real reason fails to
/// load;</description></item>
/// <item><description>report, never hide — a pass names its allow-listed
/// failures;</description></item>
/// <item><description>staleness — an entry whose test now passes is
/// reported;</description></item>
/// <item><description>subset, not intersection — one failure that is NOT on the
/// list still fails the app, whatever else is.</description></item>
/// </list>
/// </summary>
public sealed class Issue3885TestParityAllowListTests
{
    /// <summary>
    /// The three real #3885 failures as `dotnet test` reports them, verbatim in
    /// shape: three `Failed <name>` lines plus a run summary of 86 cases.
    /// </summary>
    private const string SdkTestsOutput = """
        Determining projects to restore...
          Failed GSharp.Sdk.Tests.SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build [14 ms]
          Error Message:
           System.IO.FileNotFoundException : /mirror/src/Sdk/Gsharp.HotReload.Runtime/HotReloadAgent.cs
          Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
          Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime [2 ms]
        Failed!  - Failed:     3, Passed:    83, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)
        """;

    private const string SdkTestsAppId = "test/Sdk.Tests/Sdk.Tests.csproj";

    /// <summary>The three seeded entries, exactly as the committed file spells them.</summary>
    private const string SeededAllowList = """
        {
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
        }
        """;

    // ---------------------------------------------------------------------
    // Requirement 1: granularity — individual tests, never apps.
    // ---------------------------------------------------------------------

    /// <summary>
    /// An entry that names only the app — no <c>test</c> at all — is rejected at
    /// load. Allow-listing a whole app would let a genuine regression anywhere
    /// in it pass silently, which is the failure mode that makes allow-lists
    /// dangerous in the first place.
    /// </summary>
    [Fact]
    public void WholeAppEntry_IsRejected()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                { "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
                  "reason": "these tests are all coupled to the C# spelling of the repo" } ] }
                """));

        Assert.Contains("'test' is required", error.Message, StringComparison.Ordinal);
        Assert.Contains("per TEST, never per app", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Nor can an entry name many tests by pattern.
    /// </summary>
    [Fact]
    public void WildcardEntry_IsRejected()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                { "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
                  "test": "SdkLayoutTests.Sdk_Csproj_*",
                  "reason": "these tests are all coupled to the C# spelling of the repo" } ] }
                """));

        Assert.Contains("must not contain wildcards", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A bare method name with no class is ambiguous across an app and is
    /// rejected too: the entry has to be traceable to one declaration.
    /// </summary>
    [Fact]
    public void BareMethodNameEntry_IsRejected()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                { "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
                  "test": "Sdk_Csproj_Packs_As_MSBuildSdk",
                  "reason": "reads its own repository's csproj by the C# spelling" } ] }
                """));

        Assert.Contains("at least", error.Message, StringComparison.Ordinal);
        Assert.Contains("Class.Method", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The deeper half of requirement 1, and the reason the rule is a MECHANISM
    /// rather than a convention: even an entry that LOOKS valid but names a
    /// namespace or a class matches no test at all, because matching is anchored
    /// at the method. There is no spelling of "allow-list this whole class"
    /// that works, so nobody can reach for one.
    /// </summary>
    [Fact]
    public void ClassOrNamespacePrefix_MatchesNothing()
    {
        TestParityAllowList list = TestParityAllowList.Parse("""
            {
              "entries": [
                { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "GSharp.Sdk.Tests.SdkLayoutTests",
                  "reason": "an attempt to allow-list an entire test class in one entry" },
                { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "GSharp.Sdk",
                  "reason": "an attempt to allow-list an entire namespace in one entry" }
              ]
            }
            """);

        TestParityAllowListVerdict verdict = list.Evaluate(
            SdkTestsAppId, TestParityAllowList.ParseFailedTestNames(SdkTestsOutput));

        Assert.Empty(verdict.AllowedFailures);
        Assert.Equal(3, verdict.UnallowedFailures.Count);
    }

    /// <summary>
    /// An entry is scoped to ONE app id: the same test name under a different
    /// app is not covered.
    /// </summary>
    [Fact]
    public void Entry_DoesNotLeakAcrossApps()
    {
        TestParityAllowList list = TestParityAllowList.Parse(SeededAllowList);

        TestParityAllowListVerdict verdict = list.Evaluate(
            "test/Core.Tests/Core.Tests.csproj",
            TestParityAllowList.ParseFailedTestNames(SdkTestsOutput));

        Assert.Empty(verdict.AllowedFailures);
        Assert.Equal(3, verdict.UnallowedFailures.Count);
    }

    // ---------------------------------------------------------------------
    // Requirement 2: justification is mandatory.
    // ---------------------------------------------------------------------

    /// <summary>
    /// An entry with no <c>reason</c> fails the whole load. It is not honoured
    /// with a warning and it is not skipped: an unexplained entry is how a list
    /// rots, and the run must stop rather than inherit one.
    /// </summary>
    [Fact]
    public void EntryWithoutJustification_IsRejected()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                { "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
                  "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk" } ] }
                """));

        Assert.Contains("'reason' is required", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A placeholder reason is no justification either.
    /// </summary>
    [Fact]
    public void PlaceholderJustification_IsRejected()
    {
        Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                { "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
                  "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk", "reason": "flaky" } ] }
                """));
    }

    /// <summary>
    /// A malformed <c>issue</c> reference is rejected, so the traceability the
    /// field exists for cannot quietly decay into free text.
    /// </summary>
    [Fact]
    public void MalformedIssueReference_IsRejected()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                { "entries": [ { "app": "test/Sdk.Tests/Sdk.Tests.csproj",
                  "test": "SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk",
                  "reason": "reads its own repository's csproj by the C# spelling",
                  "issue": "see the tracking issue" } ] }
                """));

        Assert.Contains("'issue' must be", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Two entries for the same test in the same app is a merge accident, and a
    /// duplicated entry is one nobody deletes. Rejected.
    /// </summary>
    [Fact]
    public void DuplicateEntry_IsRejected()
    {
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            TestParityAllowList.Parse("""
                {
                  "entries": [
                    { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "SdkLayoutTests.A",
                      "reason": "reads its own repository's csproj by the C# spelling" },
                    { "app": "test/Sdk.Tests/Sdk.Tests.csproj", "test": "SdkLayoutTests.A",
                      "reason": "reads its own repository's csproj by the C# spelling" }
                  ]
                }
                """));

        Assert.Contains("duplicate entry", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A malformed list stops the run rather than degrading to "allow nothing"
    /// (which reads as an unrelated wall of parity failures) or, worse, "allow
    /// everything".
    /// </summary>
    [Fact]
    public void MalformedJson_IsRejected()
    {
        Assert.Throws<InvalidOperationException>(() => TestParityAllowList.Parse("{ not json"));
    }

    /// <summary>
    /// No file at all means an EMPTY list — every failure fails the app — never
    /// an error and never a permissive default.
    /// </summary>
    [Fact]
    public void MissingFile_IsAnEmptyList()
    {
        TestParityAllowList list = TestParityAllowList.LoadOrEmpty(
            Path.Combine(NewDirectory(), "not-there.json"));

        Assert.Empty(list.Entries);
        Assert.Equal(
            3,
            list.Evaluate(SdkTestsAppId, TestParityAllowList.ParseFailedTestNames(SdkTestsOutput))
                .UnallowedFailures.Count);
    }

    // ---------------------------------------------------------------------
    // Requirement 5: subset, not intersection.
    // ---------------------------------------------------------------------

    /// <summary>
    /// THE load-bearing test. Three allow-listed failures plus ONE that is not
    /// on the list must fail the app — the check is "the failing set is a subset
    /// of the allowed set", never "some failures were allowed".
    /// </summary>
    [Fact]
    public void Stage_OneUnlistedFailureAmongAllowedOnes_StillFails()
    {
        string output = """
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build [14 ms]
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime [2 ms]
              Failed GSharp.Sdk.Tests.HotReloadDeltaBuilderTests.NewLocalSignature_IsMappedIntoDelta [9 ms]
            Failed!  - Failed:     4, Passed:    82, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)
            """;

        StageOutcome outcome = RunStage(SeededAllowList, output, exitCode: 1, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-TESTS-FAILED");
    }

    /// <summary>
    /// The same at list level, so the partition itself is pinned rather than
    /// only its consequence.
    /// </summary>
    [Fact]
    public void Evaluate_PartitionsRatherThanForgives()
    {
        TestParityAllowList list = TestParityAllowList.Parse(SeededAllowList);

        TestParityAllowListVerdict verdict = list.Evaluate(
            SdkTestsAppId,
            new List<string>
            {
                "GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk",
                "GSharp.Sdk.Tests.HotReloadDeltaBuilderTests.NewLocalSignature_IsMappedIntoDelta",
            });

        Assert.Single(verdict.AllowedFailures);
        Assert.Single(verdict.UnallowedFailures);
        Assert.Equal(
            "GSharp.Sdk.Tests.HotReloadDeltaBuilderTests.NewLocalSignature_IsMappedIntoDelta",
            verdict.UnallowedFailures[0]);
    }

    /// <summary>
    /// If the console output does not NAME every failure the run summary counts,
    /// the allow-list is refused outright. Otherwise an unnamed failure — a
    /// truncated log, a crashed reporter — would ride along invisibly on the
    /// named ones.
    /// </summary>
    [Fact]
    public void Stage_UnaccountedForFailure_RefusesTheAllowList()
    {
        string output = """
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
            Failed!  - Failed:     7, Passed:    79, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)
            """;

        StageOutcome outcome = RunStage(SeededAllowList, output, exitCode: 1, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
    }

    // ---------------------------------------------------------------------
    // Requirements 3 and 4, and the before/after for test/Sdk.Tests.
    // ---------------------------------------------------------------------

    /// <summary>
    /// BEFORE: with no allow-list, the real <c>test/Sdk.Tests</c> run is red.
    /// This is the state on <c>origin/main</c>, and the state the seeded list is
    /// measured against.
    /// </summary>
    [Fact]
    public void Stage_SdkTests_WithoutTheAllowList_IsRed()
    {
        StageOutcome outcome = RunStage(
            allowListJson: null, output: SdkTestsOutput, exitCode: 1, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-TESTS-FAILED");
    }

    /// <summary>
    /// AFTER: with the three entries seeded, the same run is green — and
    /// requirement 3 holds, because the three allow-listed failures are still
    /// NAMED on the context that feeds the run record and the gate summary. A
    /// silent pass would be the dangerous outcome, not the desired one.
    /// </summary>
    [Fact]
    public void Stage_SdkTests_WithTheAllowList_IsGreen_AndStillNamesTheFailures()
    {
        var context = new StageContextFixture(SeededAllowList, facts: 86);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context.Context, new ProcessRunResult(1, SdkTestsOutput, string.Empty, false));

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Empty(outcome.Artifacts);

        Assert.Equal(3, context.Context.AllowedTestFailures.Count);
        Assert.Contains(
            context.Context.AllowedTestFailures,
            name => name.EndsWith("Sdk_Csproj_Packs_As_MSBuildSdk", StringComparison.Ordinal));
        Assert.Empty(context.Context.StaleTestAllowListEntries);

        string log = context.ReadLog();
        Assert.Contains("ALLOW-LISTED", log, StringComparison.Ordinal);
        Assert.Contains("Sdk_Csproj_Packs_As_MSBuildSdk", log, StringComparison.Ordinal);
    }

    /// <summary>
    /// The other half of the before/after: REMOVE one entry while its test still
    /// fails and the app goes red again. Without this, "green with the list" is
    /// not evidence that the list is what made it green.
    /// </summary>
    [Fact]
    public void Stage_SdkTests_WithOneEntryRemoved_IsRedAgain()
    {
        // The seeded list minus Sdk_Csproj_Packs_As_MSBuildSdk, whose test still fails.
        string twoEntries = """
            {
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
            }
            """;

        StageOutcome outcome = RunStage(twoEntries, SdkTestsOutput, exitCode: 1, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-TESTS-FAILED");
    }

    /// <summary>
    /// Requirement 4: an entry whose test STARTS PASSING is reported as stale,
    /// mirroring how <c>greenApps</c> reports newly-green apps to bank. It is
    /// advisory — the app still passes — because a hard failure would make the
    /// PR that FIXES a test red, which is the wrong incentive to build into a
    /// gate.
    /// </summary>
    [Fact]
    public void Stage_AllowListedTestThatNowPasses_IsReportedStale_ButNotFatal()
    {
        string oneNowPasses = """
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build [14 ms]
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
            Failed!  - Failed:     2, Passed:    84, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)
            """;

        var context = new StageContextFixture(SeededAllowList, facts: 86);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context.Context, new ProcessRunResult(1, oneNowPasses, string.Empty, false));

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Single(context.Context.StaleTestAllowListEntries);
        Assert.Contains(
            "Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime",
            context.Context.StaleTestAllowListEntries[0],
            StringComparison.Ordinal);
        Assert.Contains(
            "no longer failing", context.ReadLog(), StringComparison.Ordinal);
    }

    /// <summary>
    /// Staleness has to be visible on a FULLY green run too, otherwise the only
    /// run that could ever report a stale entry is one that is failing for other
    /// reasons, and the list would never shrink.
    /// </summary>
    [Fact]
    public void Stage_FullyGreenRun_StillReportsEveryStaleEntry()
    {
        var context = new StageContextFixture(SeededAllowList, facts: 86);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context.Context,
            new ProcessRunResult(
                0,
                "Passed!  - Failed:     0, Passed:    86, Skipped:     0, Total:    86, Duration: 5 s - Sdk.Tests.dll (net10.0)",
                string.Empty,
                false));

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Equal(3, context.Context.StaleTestAllowListEntries.Count);
    }

    // ---------------------------------------------------------------------
    // The #3872 guard must survive the allow-list.
    // ---------------------------------------------------------------------

    /// <summary>
    /// #3872/#3869: an app whose tests fail to RUN must still fail, whatever is
    /// on the allow-list. An entry excuses a test that ran and failed; it never
    /// excuses a suite that never executed. #3869 found an app passing while
    /// running zero tests — this mechanism must not reopen that door.
    /// </summary>
    [Fact]
    public void Stage_ZeroTestsRan_StillFails_WithAFullAllowList()
    {
        string discoveryFailure = """
            [xUnit.net 00:00:00.08] Exception discovering tests from Sdk.Tests:
            System.TypeLoadException: A ByRef or ByRef-like type cannot be used ...
            No test is available in /mirror/Sdk.Tests.dll. Make sure that test discoverer & executors are registered.
            """;

        StageOutcome outcome = RunStage(SeededAllowList, discoveryFailure, exitCode: 0, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "NO-TESTS-RAN");
    }

    /// <summary>
    /// The subtler zero-test shape: a completed run that reports only
    /// allow-listed failures but executed FEWER cases than the C# original
    /// declares <c>[Fact]</c> methods. The allow-list would otherwise turn a
    /// silent coverage collapse into a green app — exactly #3869's defect, one
    /// mechanism further along.
    /// </summary>
    [Fact]
    public void Stage_CoverageDrop_StillFails_EvenWhenEveryReportedFailureIsAllowed()
    {
        string tinyRun = """
              Failed GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk [3 ms]
            Failed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4, Duration: 1 s - Sdk.Tests.dll (net10.0)
            """;

        StageOutcome outcome = RunStage(SeededAllowList, tinyRun, exitCode: 1, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-TESTS-FAILED");
    }

    /// <summary>
    /// A project that did not BUILD is still a build failure, not an
    /// allow-listable set of test failures: there are no per-test outcomes to
    /// allow. The #2867 classification must survive too.
    /// </summary>
    [Fact]
    public void Stage_BuildFailure_IsStillABuildFailure()
    {
        StageOutcome outcome = RunStage(
            SeededAllowList, "error GS0102: duplicate definition", exitCode: 1, facts: 86);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-BUILD-FAILED");
    }

    // ---------------------------------------------------------------------
    // Output parsing.
    // ---------------------------------------------------------------------

    /// <summary>
    /// The run SUMMARY line (<c>Failed!  - Failed: 3, …</c>) is not a per-test
    /// failure. Counting it as one would inflate the parsed name list past the
    /// reported total and refuse every allow-list.
    /// </summary>
    [Fact]
    public void ParseFailedTestNames_IgnoresTheRunSummaryLine()
    {
        IReadOnlyList<string> names = TestParityAllowList.ParseFailedTestNames(SdkTestsOutput);

        Assert.Equal(3, names.Count);
        Assert.All(names, name => Assert.StartsWith("GSharp.Sdk.Tests.", name, StringComparison.Ordinal));
        Assert.Equal(3, TestParityAllowList.ReportedFailureCount(SdkTestsOutput));
    }

    /// <summary>
    /// A theory row's arguments are stripped, so one entry covers the test
    /// METHOD rather than one row of its data source.
    /// </summary>
    [Fact]
    public void TheoryRows_NormalizeToTheirMethod()
    {
        Assert.Equal(
            "Ns.C.M",
            TestParityAllowList.NormalizeTestName("Ns.C.M(value: 1, other: \"x\")"));

        TestParityAllowList list = TestParityAllowList.Parse("""
            { "entries": [ { "app": "test/X/X.csproj", "test": "C.M",
              "reason": "a theory whose every row asserts the C# spelling of the repo" } ] }
            """);

        TestParityAllowListVerdict verdict = list.Evaluate(
            "test/X/X.csproj", new List<string> { "Ns.C.M(value: 1)", "Ns.C.M(value: 2)" });

        Assert.Equal(2, verdict.AllowedFailures.Count);
        Assert.Empty(verdict.UnallowedFailures);
    }

    // ---------------------------------------------------------------------
    // The committed file itself.
    // ---------------------------------------------------------------------

    /// <summary>
    /// The file the gate actually reads must load, must carry exactly the three
    /// #3885 entries, and must NOT have grown the defects under investigation
    /// (#3848/#3849 in InternalAnalyzers.Tests / LanguageServer.Tests /
    /// GeneratorHost.Tests) — those are defects, not policy, and an allow-list
    /// that absorbs them stops meaning anything.
    /// </summary>
    [Fact]
    public void CommittedAllowList_LoadsAndHoldsOnlyTheSeededEntries()
    {
        string path = Path.Combine(RepoRoot(), TestParityAllowList.DefaultRelativePath);
        Assert.True(File.Exists(path), path);

        TestParityAllowList list = TestParityAllowList.Load(path);

        Assert.Equal(3, list.Entries.Count);
        Assert.All(list.Entries, entry => Assert.Equal(SdkTestsAppId, entry.App));
        Assert.All(list.Entries, entry => Assert.Equal("#3885", entry.Issue));
        Assert.Equal(3, list.EntriesFor(SdkTestsAppId).Count);

        // Every seeded entry must actually fire against the observed run.
        TestParityAllowListVerdict verdict = list.Evaluate(
            SdkTestsAppId, TestParityAllowList.ParseFailedTestNames(SdkTestsOutput));
        Assert.Equal(3, verdict.AllowedFailures.Count);
        Assert.Empty(verdict.UnallowedFailures);
        Assert.Empty(verdict.StaleEntries);
    }

    // ---------------------------------------------------------------------
    // Requirement 3, end to end: the verdict survives the shard merge and is
    // printed by the gate.
    // ---------------------------------------------------------------------

    /// <summary>
    /// The verdict is produced by the validation SHARD that ran stage 4, so it
    /// has to survive <c>build/merge-selfmig-runs.py</c>. Dropped here, an
    /// allow-listed pass would be indistinguishable from an unconditional one in
    /// the merged run the gate reads.
    /// </summary>
    [Fact]
    public void Merge_CarriesTheAllowListVerdictFromTheShard()
    {
        string dir = NewDirectory();
        string migratePath = Path.Combine(dir, "migrate.json");
        string shardPath = Path.Combine(dir, "shard.json");
        string outPath = Path.Combine(dir, "merged.json");

        File.WriteAllText(migratePath, """
            { "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
              "succeeded": true, "apps": [ { "appId": "test/Sdk.Tests/Sdk.Tests.csproj",
                "succeeded": true, "stages": [ { "stage": "translate", "status": "passed",
                "artifactCount": 0 } ], "artifacts": [], "fingerprints": [] } ] }
            """);
        File.WriteAllText(shardPath, """
            { "runId": "r2", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
              "succeeded": true, "apps": [ { "appId": "test/Sdk.Tests/Sdk.Tests.csproj",
                "succeeded": true, "stages": [ { "stage": "test-parity", "status": "passed",
                "artifactCount": 0 } ], "artifacts": [], "fingerprints": [],
                "allowedTestFailures": [ "GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk" ],
                "staleAllowListEntries": [ "SdkLayoutTests.Gone (test/Sdk.Tests/Sdk.Tests.csproj, #3885)" ] } ] }
            """);

        (int exit, string output) = RunProcess(
            "python3",
            Path.Combine(RepoRoot(), "build", "merge-selfmig-runs.py"),
            "--migrate",
            migratePath,
            "--out",
            outPath,
            shardPath);
        Assert.True(exit == 0, output);

        string merged = File.ReadAllText(outPath);
        Assert.Contains("Sdk_Csproj_Packs_As_MSBuildSdk", merged, StringComparison.Ordinal);
        Assert.Contains("SdkLayoutTests.Gone", merged, StringComparison.Ordinal);
    }

    /// <summary>
    /// And the gate itself must PRINT both halves. A green run that says nothing
    /// about the allow-list is the failure mode this whole design exists to
    /// avoid; a stale entry that nobody is told about is how the list rots.
    /// Staleness is advisory here on purpose — the gate still PASSES — because a
    /// hard failure would make the PR that fixes a test red.
    /// </summary>
    [Fact]
    public void Gate_PrintsAllowListedFailuresAndStaleEntries_AndStillPasses()
    {
        string dir = NewDirectory();
        string runJson = Path.Combine(dir, "run.json");
        string baseline = Path.Combine(dir, "baseline.json");

        File.WriteAllText(runJson, """
            { "apps": [ { "appId": "test/Sdk.Tests/Sdk.Tests.csproj", "succeeded": true,
                "allowedTestFailures": [ "GSharp.Sdk.Tests.SdkLayoutTests.Sdk_Csproj_Packs_As_MSBuildSdk" ],
                "staleAllowListEntries": [ "SdkLayoutTests.Gone (test/Sdk.Tests/Sdk.Tests.csproj, #3885)" ] } ] }
            """);
        File.WriteAllText(baseline, """
            { "greenFloor": 1, "syntheticLabelCeiling": 0, "liftedLocalCeiling": 0,
              "longLineCeiling": 0, "nullAssertionCeiling": 0,
              "greenApps": [ "test/Sdk.Tests/Sdk.Tests.csproj" ] }
            """);

        string script = Path.Combine(dir, "gate.sh");
        File.WriteAllText(script,
            "set -euo pipefail\n" +
            "source '" + Path.Combine(RepoRoot(), "build", "selfmig-common.sh") + "'\n" +
            "labels=0; lifts=0; long_lines=0; bangs=0\n" +
            "selfmig_apply_baseline '" + baseline + "' 1 1 '" + runJson + "'\n");

        (int exit, string output) = RunProcess("bash", script);

        Assert.True(exit == 0, output);
        Assert.Contains("Self-migration gate PASSED.", output, StringComparison.Ordinal);
        Assert.Contains("allow-listed test-parity failures", output, StringComparison.Ordinal);
        Assert.Contains("Sdk_Csproj_Packs_As_MSBuildSdk", output, StringComparison.Ordinal);
        Assert.Contains("no longer failing", output, StringComparison.Ordinal);
        Assert.Contains("SdkLayoutTests.Gone", output, StringComparison.Ordinal);
    }

    private static (int Exit, string Output) RunProcess(string fileName, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo);
        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, output);
    }

    private static StageOutcome RunStage(
        string allowListJson, string output, int exitCode, int facts)
    {
        var fixture = new StageContextFixture(allowListJson, facts);
        return new TestParityStage().EvaluateMirroredTestRun(
            fixture.Context, new ProcessRunResult(exitCode, output, string.Empty, false));
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("repository root not found from " + AppContext.BaseDirectory);
    }

    private static string NewDirectory()
    {
        string path = Path.Combine(
            AppContext.BaseDirectory, "issue-3885-allowlist", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>
    /// A stage context whose C# "original" declares <paramref name="facts"/>
    /// <c>[Fact]</c> methods, so the #3872 lower bound is real rather than
    /// disabled — a fixture with 0 facts would let a coverage-drop test pass for
    /// the wrong reason.
    /// </summary>
    private sealed class StageContextFixture
    {
        private readonly string directory;

        internal StageContextFixture(string allowListJson, int facts)
        {
            this.directory = NewDirectory();

            var source = new System.Text.StringBuilder();
            source.AppendLine("using Xunit;");
            source.AppendLine("public class Own {");
            for (int i = 0; i < facts; i++)
            {
                source.AppendLine($"    [Fact] public void T{i}() {{ }}");
            }

            source.AppendLine("}");

            string csPath = Path.Combine(this.directory, "Own.cs");
            File.WriteAllText(csPath, source.ToString());

            string projectPath = Path.Combine(this.directory, "Sdk.Tests.csproj");
            File.WriteAllText(projectPath, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
                </Project>
                """);

            var app = new CorpusApp(SdkTestsAppId, projectPath, TargetKind.Library);
            var options = new PipelineOptions
            {
                OutputRoot = this.directory,
                TestParityAllowList = allowListJson is null
                    ? null
                    : TestParityAllowList.Parse(allowListJson),
            };
            var triage = new TriageBuilder("run_1", "2026-09-04T00:00:00Z", "0.0.0", app.Id);
            this.Context = new StageExecutionContext(
                app, options, new GscInvoker(FindCompiler()), this.directory, triage);
            this.Context.EmittedFiles.Add(new EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty));
        }

        internal StageExecutionContext Context { get; }

        internal string ReadLog()
        {
            string log = Path.Combine(this.directory, "test-parity.log");
            return File.Exists(log) ? File.ReadAllText(log) : string.Empty;
        }

        private static string FindCompiler()
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null)
            {
                foreach (string config in new[] { "Release", "Debug" })
                {
                    string candidate = Path.Combine(
                        dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }

                dir = dir.Parent;
            }

            return "gsc.dll";
        }
    }
}
