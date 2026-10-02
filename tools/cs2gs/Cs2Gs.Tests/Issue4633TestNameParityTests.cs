// <copyright file="Issue4633TestNameParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security;
using System.Text;
using System.Threading.Tasks;
using Cs2Gs.Cli;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4633: mirrored test projects are checked NAME FOR NAME against the C#
/// original's discovered cases. Before this, parity was "exit 0 and at least as
/// many cases as the C# original has [Fact] methods", so any [Theory] row, or
/// any case beyond the fact count, could vanish without the gate noticing.
/// </summary>
public sealed class Issue4633TestNameParityTests
{
    private const string AppId = "test/Own.Tests/Own.Tests.csproj";

    private const string GreenRunOutput = """
        Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4, Duration: 1 s - Own.Tests.dll (net10.0)
        """;

    private static readonly string[] OracleNames =
    {
        "Own.Tests.A.Works",
        "Own.Tests.A.Adds(x: 1)",
        "Own.Tests.A.Adds(x: 2)",
        "Own.Tests.B.Works",
    };

    // ---------------------------------------------------------------------
    // The comparison engine.
    // ---------------------------------------------------------------------

    /// <summary>The same cases on both sides match, in either order.</summary>
    [Fact]
    public void Compare_IdenticalCases_Match()
    {
        TestNameParityResult result = TestNameParity.Compare(
            OracleNames, Passed(OracleNames.Reverse().ToArray()));

        Assert.True(result.IsMatch);
        Assert.Equal(4, result.Matched);
    }

    /// <summary>
    /// The class of loss the count-only gate could not see: one theory ROW
    /// disappears. Every [Fact] still runs, so the old floor was satisfied.
    /// </summary>
    [Fact]
    public void Compare_LostTheoryRow_IsMissing()
    {
        TestNameParityResult result = TestNameParity.Compare(
            OracleNames, Passed("Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works"));

        Assert.False(result.IsMatch);
        Assert.Equal(new[] { "Own.Tests.A.Adds(x: 2)" }, result.Missing);
        Assert.Empty(result.Extra);
    }

    /// <summary>A case the C# original does not have is reported, not ignored.</summary>
    [Fact]
    public void Compare_UnknownCase_IsExtra()
    {
        TestNameParityResult result = TestNameParity.Compare(
            OracleNames, Passed(OracleNames.Append("Own.Tests.B.Surprise").ToArray()));

        Assert.Equal(new[] { "Own.Tests.B.Surprise" }, result.Extra);
        Assert.Empty(result.Missing);
    }

    /// <summary>
    /// Names are fully qualified (xUnit ClassAndMethod), so two classes' methods
    /// of the same name are two cases: losing one of them is caught.
    /// </summary>
    [Fact]
    public void Compare_SameMethodNameInTwoClasses_AreDistinct()
    {
        TestNameParityResult result = TestNameParity.Compare(
            OracleNames, Passed("Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.A.Adds(x: 2)"));

        Assert.Equal(new[] { "Own.Tests.B.Works" }, result.Missing);
    }

    /// <summary>
    /// A theory xUnit does not pre-enumerate is ONE bare case in discovery and a
    /// result per row in execution. Those rows satisfy the bare name; nothing
    /// is reported missing or extra.
    /// </summary>
    [Fact]
    public void Compare_NonEnumeratedTheory_IsSatisfiedByItsRows()
    {
        TestNameParityResult result = TestNameParity.Compare(
            new[] { "Own.Tests.A.Cells" },
            Passed("Own.Tests.A.Cells(cell: Cell(X=1))", "Own.Tests.A.Cells(cell: Cell(X=2))"));

        Assert.True(result.IsMatch);
        Assert.Equal(1, result.Matched);
        Assert.Equal(2, result.TheoryRows);
    }

    /// <summary>A bare C# case with neither an exact result nor any row is missing.</summary>
    [Fact]
    public void Compare_BareCaseWithNoResultOrRows_IsMissing()
    {
        TestNameParityResult result = TestNameParity.Compare(
            new[] { "Own.Tests.A.Cells", "Own.Tests.A.Other" }, Passed("Own.Tests.A.Other"));

        Assert.Equal(new[] { "Own.Tests.A.Cells" }, result.Missing);
    }

    /// <summary>
    /// Rows whose arguments render identically are separate cases: comparison is
    /// a multiset, so one of two identical rows disappearing is still caught.
    /// </summary>
    [Fact]
    public void Compare_DuplicateDisplayNames_AreCountedNotCollapsed()
    {
        TestNameParityResult result = TestNameParity.Compare(
            new[] { "Own.Tests.A.Long(s: \"aaa\"···)", "Own.Tests.A.Long(s: \"aaa\"···)" },
            Passed("Own.Tests.A.Long(s: \"aaa\"···)"));

        Assert.Equal(new[] { "Own.Tests.A.Long(s: \"aaa\"···)" }, result.Missing);
    }

    /// <summary>
    /// A C# record argument renders as <c>R { A = 1 }</c> and the G# data type
    /// as <c>R(A=1)</c> (ADR-0029); the existing #2833 normalization applies.
    /// </summary>
    [Fact]
    public void Compare_RecordRendering_IsNormalized()
    {
        TestNameParityResult result = TestNameParity.Compare(
            new[] { "Own.Tests.A.M(r: R { A = 1 })" }, Passed("Own.Tests.A.M(r: R(A=1))"));

        Assert.True(result.IsMatch);
    }

    // ---------------------------------------------------------------------
    // The C# oracle.
    // ---------------------------------------------------------------------

    /// <summary>The real `dotnet test --list-tests` shape parses into its names.</summary>
    [Fact]
    public void Oracle_ParsesListTestsOutput()
    {
        const string output = """
            Test run for /repo/out/bin/Release/Own.Tests/Own.Tests.dll (.NETCoreApp,Version=v10.0)
            The following Tests are available:
                Own.Tests.A.Works
                Own.Tests.A.Adds(x: 1)
            """;

        IReadOnlyList<string> names = CSharpTestOracle.ParseListTestsOutput(output);

        Assert.Equal(new[] { "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)" }, names);
    }

    /// <summary>
    /// A listing that failed, or listed nothing, must never become an empty
    /// oracle: an empty oracle would make the per-name check a check of nothing.
    /// </summary>
    [Theory]
    [InlineData("The argument /repo/Own.Tests.dll is invalid.")]
    [InlineData("The following Tests are available:\n")]
    [InlineData("")]
    public void Oracle_NoHeaderOrNoNames_Throws(string output)
    {
        Assert.Throws<InvalidOperationException>(() => CSharpTestOracle.ParseListTestsOutput(output));
    }

    /// <summary>An oracle round-trips; an absent one loads as null; a mislabelled one is rejected.</summary>
    [Fact]
    public void Oracle_RoundTripsAndRejectsAnotherAppsFile()
    {
        string dir = NewDirectory();
        CSharpTestOracle.Create(AppId, OracleNames).Write(dir);

        CSharpTestOracle loaded = CSharpTestOracle.LoadOrNull(dir, AppId);
        Assert.NotNull(loaded);
        Assert.Equal(OracleNames.OrderBy(n => n, StringComparer.Ordinal), loaded.Tests);
        Assert.Null(CSharpTestOracle.LoadOrNull(dir, "test/Other.Tests/Other.Tests.csproj"));

        File.Copy(
            Path.Combine(dir, CSharpTestOracle.FileNameFor(AppId)),
            Path.Combine(dir, CSharpTestOracle.FileNameFor("test/Other.Tests/Other.Tests.csproj")));
        Assert.Throws<InvalidOperationException>(
            () => CSharpTestOracle.LoadOrNull(dir, "test/Other.Tests/Other.Tests.csproj"));
    }

    /// <summary>
    /// Review finding: two app ids that sanitize to the same string must not
    /// share an oracle file, or one app would be checked against the other's
    /// cases.
    /// </summary>
    [Fact]
    public void Oracle_FileNames_DoNotCollideForIdsThatSanitizeAlike()
    {
        Assert.NotEqual(
            CSharpTestOracle.FileNameFor("a/b_c/X.Tests.csproj"),
            CSharpTestOracle.FileNameFor("a_b/c/X.Tests.csproj"));
    }

    /// <summary>
    /// Review finding: capture and the stage share one classification, and the
    /// evaluated MSBuild <c>IsTestProject</c> alone makes a project a mirrored
    /// test project even when its file does not say so.
    /// </summary>
    [Fact]
    public void MirroredTestClassification_HonoursTheEvaluatedProperty()
    {
        string dir = NewDirectory();
        string plain = Path.Combine(dir, "Plain.csproj");
        File.WriteAllText(plain, "<Project Sdk=\"Microsoft.NET.Sdk\" />");

        Assert.False(TestParityStage.IsMirroredTestProject(false, plain));
        Assert.True(TestParityStage.IsMirroredTestProject(true, plain));
    }

    // ---------------------------------------------------------------------
    // The baseline of justified differences.
    // ---------------------------------------------------------------------

    /// <summary>Every entry must be scoped, typed, explained and tracked.</summary>
    [Fact]
    public void Baseline_RejectsUnjustifiedEntries()
    {
        var entries = new List<TestNameParityBaselineEntry>
        {
            new() { App = AppId, Kind = "missing", Test = "Own.Tests.A.Works", Reason = "short", Issue = "#1" },
            new() { App = AppId, Kind = "missing", Test = "Own.Tests.A.Works2", Reason = new string('r', 30), Issue = null },
            new() { App = AppId, Kind = "gone", Test = "Own.Tests.A.Works3", Reason = new string('r', 30), Issue = "#1" },
            new() { App = "test/Own.Tests", Kind = "extra", Test = "Own.Tests.A.Works4", Reason = new string('r', 30), Issue = "#1" },
            new() { App = AppId, Kind = "rows", Test = "Own.Tests.A.Adds(x: 1)", Reason = new string('r', 30), Issue = "#1" },
        };

        IReadOnlyList<string> errors = TestNameParityBaseline.ValidateEntries(entries);

        Assert.Equal(5, errors.Count);
        Assert.Contains(errors, e => e.Contains("'reason'", StringComparison.Ordinal));
        Assert.Contains(errors, e => e.Contains("'issue'", StringComparison.Ordinal));
        Assert.Contains(errors, e => e.Contains("'kind'", StringComparison.Ordinal));
        Assert.Contains(errors, e => e.Contains("'app'", StringComparison.Ordinal));
        Assert.Contains(errors, e => e.Contains("without an argument list", StringComparison.Ordinal));
    }

    /// <summary>An entry explains exactly its own difference; an unused entry is stale.</summary>
    [Fact]
    public void Baseline_ExplainsListedDifference_AndReportsStaleEntries()
    {
        TestNameParityBaseline baseline = Baseline(
            Entry("missing", "Own.Tests.A.Adds(x: 2)"),
            Entry("extra", "Own.Tests.B.NoLongerThere"));
        TestNameParityResult result = TestNameParity.Compare(
            OracleNames, Passed("Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)"));

        TestNameParityVerdict verdict = baseline.Evaluate(AppId, result);

        Assert.False(verdict.IsMatch);
        Assert.Equal(new[] { "Own.Tests.B.Works" }, verdict.UnexplainedMissing);
        Assert.Equal(new[] { "missing: Own.Tests.A.Adds(x: 2)" }, verdict.Explained);
        Assert.Equal("Own.Tests.B.NoLongerThere", Assert.Single(verdict.StaleEntries).Test);
    }

    /// <summary>
    /// A <c>rows</c> entry covers a rendering difference (same number of rows on
    /// both sides) and nothing more: a row that is actually lost stays a failure.
    /// </summary>
    [Fact]
    public void Baseline_RowsEntry_ExcusesRenderingNotLoss()
    {
        TestNameParityBaseline baseline = Baseline(Entry("rows", "Own.Tests.A.Adds"));
        string[] oracle = { "Own.Tests.A.Adds(x: 1.5)", "Own.Tests.A.Adds(x: 2.5)" };

        TestNameParityVerdict rendered = baseline.Evaluate(
            AppId, TestNameParity.Compare(oracle, Passed("Own.Tests.A.Adds(x: 1,5)", "Own.Tests.A.Adds(x: 2,5)")));
        TestNameParityVerdict lost = baseline.Evaluate(
            AppId, TestNameParity.Compare(oracle, Passed("Own.Tests.A.Adds(x: 1,5)")));

        Assert.True(rendered.IsMatch);
        Assert.Empty(rendered.StaleEntries);
        Assert.Contains("rows: Own.Tests.A.Adds (2 row(s) render differently)", rendered.Explained);
        Assert.False(lost.IsMatch);
        Assert.Equal(2, lost.UnexplainedMissing.Count);
    }

    /// <summary>
    /// A <c>rows</c> entry does not hide a lost row behind an unrelated added
    /// one with the same count: the rows must pair up by argument structure.
    /// </summary>
    [Fact]
    public void Baseline_RowsEntry_RequiresMatchingArgumentStructure()
    {
        TestNameParityBaseline baseline = Baseline(Entry("rows", "Own.Tests.A.Adds"));
        string[] oracle = { "Own.Tests.A.Adds(x: 1.5)" };

        TestNameParityVerdict swapped = baseline.Evaluate(
            AppId, TestNameParity.Compare(oracle, Passed("Own.Tests.A.Adds(y: 2, z: 3)")));

        Assert.False(swapped.IsMatch);
        Assert.Single(swapped.UnexplainedMissing);
        Assert.Single(swapped.UnexplainedExtra);
    }

    /// <summary>
    /// Review finding: names are a multiset, so one exact entry excuses ONE
    /// occurrence. A second identical missing row needs <c>count</c>.
    /// </summary>
    [Fact]
    public void Baseline_ExactEntry_ExcusesOneOccurrenceUnlessCounted()
    {
        string[] oracle = { "Own.Tests.A.Long(s: \"aaa\"···)", "Own.Tests.A.Long(s: \"aaa\"···)", "Own.Tests.A.Works" };
        TestNameParityResult result = TestNameParity.Compare(oracle, Passed("Own.Tests.A.Works"));

        TestNameParityVerdict once = Baseline(Entry("missing", "Own.Tests.A.Long(s: \"aaa\"···)")).Evaluate(AppId, result);
        TestNameParityBaselineEntry twice = Entry("missing", "Own.Tests.A.Long(s: \"aaa\"···)");
        twice.Count = 2;
        TestNameParityVerdict counted = Baseline(twice).Evaluate(AppId, result);

        Assert.Single(once.UnexplainedMissing);
        Assert.True(counted.IsMatch);
        Assert.Empty(counted.StaleEntries);
    }

    /// <summary>
    /// Review finding: names are matched exactly, so `?` and `*` in a theory
    /// row's argument are literal characters; an entry never matches anything
    /// but the one name it spells.
    /// </summary>
    [Fact]
    public void Baseline_WildcardCharactersAreLiteral()
    {
        TestNameParityBaseline baseline = Baseline(Entry("missing", "Own.Tests.A.Ask(q: \"why?\")"));
        string[] oracle = { "Own.Tests.A.Ask(q: \"why?\")", "Own.Tests.A.Ask(q: \"whyX\")" };

        TestNameParityVerdict verdict = baseline.Evaluate(AppId, TestNameParity.Compare(oracle, Passed()));

        Assert.Equal(new[] { "Own.Tests.A.Ask(q: \"whyX\")" }, verdict.UnexplainedMissing);
    }

    /// <summary>The checked-in baseline loads: every entry in it is justified and tracked.</summary>
    [Fact]
    public void CheckedInBaseline_IsValid()
    {
        string path = Path.Combine(RepoRoot(), TestNameParityBaseline.DefaultRelativePath);

        Assert.True(File.Exists(path), path);
        TestNameParityBaseline.Load(path);
    }

    // ---------------------------------------------------------------------
    // The stage verdict (ADR-0154 witnesses).
    // ---------------------------------------------------------------------

    /// <summary>
    /// The discriminating witness. The run exits 0 and executes more cases than
    /// the C# original has [Fact] methods, so the count-only gate PASSES it (see
    /// <see cref="Stage_WithoutOracle_KeepsCountOnlyAndSaysSo"/>). It lost a
    /// theory row, so per-name parity must FAIL it.
    /// </summary>
    [Fact]
    public void Stage_LostTheoryRow_FailsPerNameParity()
    {
        StageExecutionContext context = Context(withOracle: true);
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works");

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, GreenRunOutput, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        TriageArtifact artifact = Assert.Single(outcome.Artifacts);
        Assert.Equal("TEST-NAME-PARITY", artifact.Diagnostic.Id);
        Assert.Contains("Own.Tests.A.Adds(x: 2)", artifact.Diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal(1, context.TestNameParity.Missing);
        Assert.True(File.Exists(Path.Combine(context.ArtifactDir, TestParityStage.TestNameParityFileName)));
    }

    /// <summary>The other direction: an identical case set passes and records its counts.</summary>
    [Fact]
    public void Stage_IdenticalCases_PassesAndRecordsCounts()
    {
        StageExecutionContext context = Context(withOracle: true);
        WriteTrx(context, OracleNames);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, GreenRunOutput, string.Empty, false));

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Empty(outcome.Artifacts);
        Assert.Equal(TestNameParitySummary.PerNameMode, context.TestNameParity.Mode);
        Assert.Equal(4, context.TestNameParity.CSharpCases);
        Assert.Equal(4, context.TestNameParity.MigratedCases);
        Assert.Equal(4, context.TestNameParity.Matched);
    }

    /// <summary>
    /// Without an oracle directory the stage keeps the count-only check, and the
    /// lost row above passes, which is exactly the blind spot. The run record
    /// says <c>count-only</c> so it can never be mistaken for per-name parity.
    /// </summary>
    [Fact]
    public void Stage_WithoutOracle_KeepsCountOnlyAndSaysSo()
    {
        StageExecutionContext context = Context(withOracle: false);
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works");

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, GreenRunOutput, string.Empty, false));

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Equal(TestNameParitySummary.CountOnlyMode, context.TestNameParity.Mode);
    }

    /// <summary>
    /// Review finding: a run that misses the [Fact] floor still gets its
    /// per-name summary and diff, so every completed run is auditable.
    /// </summary>
    [Fact]
    public void Stage_BelowTheFactFloor_StillRecordsNameParity()
    {
        StageExecutionContext context = Context(withOracle: true);
        WriteTrx(context, "Own.Tests.A.Works");
        const string output = """
            Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 1 s - Own.Tests.dll (net10.0)
            """;

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, output, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "NO-TESTS-RAN");
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "TEST-NAME-PARITY");
        Assert.NotNull(context.TestNameParity);
        Assert.Equal(3, context.TestNameParity.Missing);
    }

    /// <summary>A configured oracle directory with no file for this app fails; it never falls back.</summary>
    [Fact]
    public void Stage_MissingOracleFile_Fails()
    {
        StageExecutionContext context = Context(withOracle: true);
        File.Delete(Path.Combine(context.Options.CSharpTestOracleDirectory, CSharpTestOracle.FileNameFor(AppId)));
        WriteTrx(context, OracleNames);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, GreenRunOutput, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Equal("TEST-ORACLE-MISSING", Assert.Single(outcome.Artifacts).Diagnostic.Id);
    }

    /// <summary>A run that left no TRX cannot be compared and fails.</summary>
    [Fact]
    public void Stage_MissingTrx_Fails()
    {
        StageExecutionContext context = Context(withOracle: true);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, GreenRunOutput, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Equal("TEST-RESULTS-UNREADABLE", Assert.Single(outcome.Artifacts).Diagnostic.Id);
    }

    /// <summary>Zero migrated results where the C# original has cases is a failure.</summary>
    [Fact]
    public void Stage_ZeroResults_Fails()
    {
        StageExecutionContext context = Context(withOracle: true);
        WriteTrx(context);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(0, GreenRunOutput, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        TriageArtifact artifact = Assert.Single(outcome.Artifacts);
        Assert.Contains("ZERO", artifact.Diagnostic.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The failure allow-list excuses a failing case, never a missing one: a run
    /// whose failures are all allow-listed still fails when a case is lost.
    /// </summary>
    [Fact]
    public void Stage_AllowListedFailures_DoNotExcuseAMissingCase()
    {
        StageExecutionContext context = Context(withOracle: true);
        context.Options.TestParityAllowList = TestParityAllowList.Parse("""
            { "entries": [ { "app": "test/Own.Tests/Own.Tests.csproj", "test": "A.Works",
              "reason": "fails for a documented policy reason in this fixture", "issue": "#4633" } ] }
            """);
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works");
        const string output = """
              Failed Own.Tests.A.Works [3 ms]
            Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 1 s - Own.Tests.dll (net10.0)
            """;

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(1, output, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Equal("TEST-NAME-PARITY", Assert.Single(outcome.Artifacts).Diagnostic.Id);
    }

    // ---------------------------------------------------------------------
    // Plumbing: the summary survives the shard merge; validate is fail-safe.
    // ---------------------------------------------------------------------

    /// <summary>The per-name counts survive build/merge-selfmig-runs.py into the merged run.</summary>
    [Fact]
    public void Merge_CarriesTestNameParityFromTheShard()
    {
        string dir = NewDirectory();
        string migratePath = Path.Combine(dir, "migrate.json");
        string shardPath = Path.Combine(dir, "shard.json");
        string outPath = Path.Combine(dir, "merged.json");
        File.WriteAllText(migratePath, """
            { "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
              "succeeded": true, "apps": [ { "appId": "test/Own.Tests/Own.Tests.csproj",
              "succeeded": true, "stages": [ { "stage": "translate", "status": "passed",
              "artifactCount": 0 } ], "artifacts": [], "fingerprints": [] } ] }
            """);
        File.WriteAllText(shardPath, """
            { "runId": "r2", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
              "succeeded": true, "apps": [ { "appId": "test/Own.Tests/Own.Tests.csproj",
              "succeeded": true, "stages": [ { "stage": "test-parity", "status": "passed",
              "artifactCount": 0 } ], "artifacts": [], "fingerprints": [],
              "testNameParity": { "mode": "per-name", "csharpCases": 10920, "migratedCases": 10920 } } ] }
            """);

        ProcessRunResult run = ProcessRunner.Run(
            "python3",
            new[]
            {
                Path.Combine(RepoRoot(), "build", "merge-selfmig-runs.py"),
                "--migrate", migratePath, "--out", outPath, shardPath,
            });

        Assert.True(run.ExitCode == 0, run.Output);
        string merged = File.ReadAllText(outPath);
        Assert.Contains("\"csharpCases\": 10920", merged, StringComparison.Ordinal);
        Assert.Contains("\"per-name\"", merged, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shard command refuses to run without either the oracle or an
    /// explicit opt-out, so dropping one flag from the gate script cannot
    /// silently restore the count-only check.
    /// </summary>
    [Fact]
    public async Task Validate_RequiresTheOracleOrAnExplicitOptOut()
    {
        string dir = NewDirectory();
        var originalError = Console.Error;
        var captured = new StringWriter();
        Console.SetError(captured);
        int exit;
        try
        {
            exit = await ValidateCommand.RunAsync(new[] { "--corpus", dir, "--migrated", dir });
        }
        finally
        {
            Console.SetError(originalError);
        }

        Assert.Equal(1, exit);
        Assert.Contains("--csharp-test-oracle", captured.ToString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// Issue #4633 raised the budget ceiling: nightly 36906270739 measured the
    /// migrated Compiler.Tests run (4,492 declared facts) at 4,941 s, 91% of the
    /// old 90-minute ceiling. Its budget must leave at least 20% headroom over
    /// that measurement.
    /// </summary>
    [Fact]
    public void Budget_CompilerTestsHasHeadroomOverItsMeasuredRun()
    {
        TimeSpan budget = SdkCompileRunner.MirroredTestRunTimeoutFor(4492);

        Assert.True(
            budget.TotalSeconds >= 4941 * 1.2,
            $"Compiler.Tests' budget {budget} leaves under 20% headroom over its measured 4,941 s.");
    }

    private static TestCaseOutcome[] Passed(params string[] names) =>
        names.Select(name => new TestCaseOutcome(name, "Passed")).ToArray();

    private static TestNameParityBaselineEntry Entry(string kind, string test) => new()
    {
        App = AppId,
        Kind = kind,
        Test = test,
        Reason = "a justified difference used by this test fixture",
        Issue = "#4633",
    };

    private static TestNameParityBaseline Baseline(params TestNameParityBaselineEntry[] entries) =>
        TestNameParityBaseline.Parse(System.Text.Json.JsonSerializer.Serialize(
            new TestNameParityBaselineDocument { Entries = entries.ToList() }));

    private static StageExecutionContext Context(bool withOracle)
    {
        string dir = NewDirectory();
        string csPath = Path.Combine(dir, "Own.cs");
        File.WriteAllText(
            csPath,
            "using Xunit; public class A { [Fact] public void Works() { } } public class B { [Fact] public void Works() { } }");
        string projectPath = Path.Combine(dir, "Own.Tests.csproj");
        File.WriteAllText(projectPath, "<Project Sdk=\"Microsoft.NET.Sdk\" />");

        var app = new CorpusApp(AppId, projectPath, TargetKind.Library);
        var options = new PipelineOptions { OutputRoot = dir };
        if (withOracle)
        {
            string oracleDir = Path.Combine(dir, "oracle");
            CSharpTestOracle.Create(AppId, OracleNames).Write(oracleDir);
            options.CSharpTestOracleDirectory = oracleDir;
        }

        var triage = new TriageBuilder("run_1", "2026-10-01T00:00:00Z", "0.0.0", app.Id);
        var context = new StageExecutionContext(app, options, new GscInvoker("gsc.dll"), dir, triage);
        context.EmittedFiles.Add(new EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty));
        return context;
    }

    private static void WriteTrx(StageExecutionContext context, params string[] names)
    {
        var trx = new StringBuilder();
        trx.AppendLine("<?xml version=\"1.0\" encoding=\"utf-8\"?>");
        trx.AppendLine("<TestRun xmlns=\"http://microsoft.com/schemas/VisualStudio/TeamTest/2010\"><Results>");
        foreach (string name in names)
        {
            trx.Append("<UnitTestResult testName=\"").Append(SecurityElement.Escape(name))
                .AppendLine("\" outcome=\"Passed\" />");
        }

        trx.AppendLine("</Results></TestRun>");
        string path = SdkCompileRunner.MirroredTestResultsPath(context.ArtifactDir);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, trx.ToString());
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
            AppContext.BaseDirectory, "issue-4633-test-name-parity", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
