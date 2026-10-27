// <copyright file="Issue4633TestNameParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Security
import System.Text
import System.Text.Json
import System.Threading.Tasks
import Xunit

/// Issue #4633: mirrored test projects are checked NAME FOR NAME against the C#
/// original's discovered cases. Before this, parity was "exit 0 and at least as
/// many cases as the C# original has [Fact] methods", so any [Theory] row, or
/// any case beyond the fact count, could vanish without the gate noticing.
class Issue4633TestNameParityTests {
    // ---------------------------------------------------------------------
    // The comparison engine.
    // ---------------------------------------------------------------------
    /// The same cases on both sides match, in either order.
    @Fact
    func Compare_IdenticalCases_Match() {
        let result = TestNameParity.Compare(OracleNames, Passed(OracleNames.Reverse().ToArray()))
        Assert.True(result.IsMatch)
        Assert.Equal(4, result.Matched)
    }

    /// The class of loss the count-only gate could not see: one theory ROW
    /// disappears. Every [Fact] still runs, so the old floor was satisfied.
    @Fact
    func Compare_LostTheoryRow_IsMissing() {
        let result = TestNameParity.Compare(
            OracleNames,
            Passed("Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works")
        )
        Assert.False(result.IsMatch)
        Assert.Equal([]string{"Own.Tests.A.Adds(x: 2)"}, result.Missing)
        Assert.Empty(result.Extra)
    }

    /// A case the C# original does not have is reported, not ignored.
    @Fact
    func Compare_UnknownCase_IsExtra() {
        let result = TestNameParity.Compare(OracleNames, Passed(OracleNames.Append("Own.Tests.B.Surprise").ToArray()))
        Assert.Equal([]string{"Own.Tests.B.Surprise"}, result.Extra)
        Assert.Empty(result.Missing)
    }

    /// Names are fully qualified (xUnit ClassAndMethod), so two classes' methods
    /// of the same name are two cases: losing one of them is caught.
    @Fact
    func Compare_SameMethodNameInTwoClasses_AreDistinct() {
        let result = TestNameParity.Compare(
            OracleNames,
            Passed("Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.A.Adds(x: 2)")
        )
        Assert.Equal([]string{"Own.Tests.B.Works"}, result.Missing)
    }

    /// A theory xUnit does not pre-enumerate is ONE bare case in discovery and a
    /// result per row in execution. Those rows satisfy the bare name; nothing
    /// is reported missing or extra.
    @Fact
    func Compare_NonEnumeratedTheory_IsSatisfiedByItsRows() {
        let result = TestNameParity.Compare(
            []string{"Own.Tests.A.Cells"},
            Passed("Own.Tests.A.Cells(cell: Cell(X=1))", "Own.Tests.A.Cells(cell: Cell(X=2))")
        )
        Assert.True(result.IsMatch)
        Assert.Equal(1, result.Matched)
        Assert.Equal(2, result.TheoryRows)
    }

    /// Review finding: a bare name listed twice (two target frameworks) needs a
    /// row per occurrence; one row cannot satisfy both.
    @Fact
    func Compare_DuplicateBareNames_EachNeedARow() {
        let result = TestNameParity.Compare(
            []string{"Own.Tests.A.Cells", "Own.Tests.A.Cells"},
            Passed("Own.Tests.A.Cells(cell: Cell(X=1))")
        )
        Assert.Equal([]string{"Own.Tests.A.Cells"}, result.Missing)
        Assert.Equal(1, result.Matched)
    }

    /// Review finding: an oracle holding an empty name is rejected, not silently shrunk.
    @Fact
    func Oracle_EmptyName_IsRejected() {
        let dir = NewDirectory()
        CSharpTestOracle.Create(AppId, []string{"Own.Tests.A.Works", string.Empty}).Write(dir)
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CSharpTestOracle.LoadOrNull(dir, AppId)
            }
        )
    }

    /// A bare C# case with neither an exact result nor any row is missing.
    @Fact
    func Compare_BareCaseWithNoResultOrRows_IsMissing() {
        let result = TestNameParity.Compare(
            []string{"Own.Tests.A.Cells", "Own.Tests.A.Other"},
            Passed("Own.Tests.A.Other")
        )
        Assert.Equal([]string{"Own.Tests.A.Cells"}, result.Missing)
    }

    /// Rows whose arguments render identically are separate cases: comparison is
    /// a multiset, so one of two identical rows disappearing is still caught.
    @Fact
    func Compare_DuplicateDisplayNames_AreCountedNotCollapsed() {
        let result = TestNameParity.Compare(
            []string{"Own.Tests.A.Long(s: \"aaa\"···)", "Own.Tests.A.Long(s: \"aaa\"···)"},
            Passed("Own.Tests.A.Long(s: \"aaa\"···)")
        )
        Assert.Equal([]string{"Own.Tests.A.Long(s: \"aaa\"···)"}, result.Missing)
    }

    /// A C# record argument and a G# data type both render as `R { A = 1 }`
    /// (ADR-0199), so the names match verbatim; the retired Kotlin spelling does not.
    @Fact
    func Compare_RecordRendering_MatchesVerbatim() {
        let result = TestNameParity.Compare(
            []string{"Own.Tests.A.M(r: R { A = 1 })"},
            Passed("Own.Tests.A.M(r: R { A = 1 })")
        )
        Assert.True(result.IsMatch)
        let kotlin = TestNameParity.Compare(
            []string{"Own.Tests.A.M(r: R { A = 1 })"},
            Passed("Own.Tests.A.M(r: R(A=1))")
        )
        Assert.False(kotlin.IsMatch)
    }

    // ---------------------------------------------------------------------
    // The C# oracle.
    // ---------------------------------------------------------------------
    /// A selected library shard needs no oracle. Unknown selections still fail.
    @Fact
    func Capture_ExplicitLibrarySelection_DoesNotRequireTests() {
        let directory = NewDirectory()
        let initialized = ProcessRunner.Run("git", []string{"init", "--quiet", directory})
        Assert.True(initialized.ExitCode == 0, initialized.Output)
        File.WriteAllText(Path.Combine(directory, "Library.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        let output = Path.Combine(directory, "oracle")
        let driver = Path.Combine(RepoRoot(), "out", "bin", "Release", "Cs2Gs.Cli", "cs2gs.dll")
        let arguments = []string{"capture-test-oracle", "--corpus", directory, "--out", output}
        let selected = ProcessRunner.Run(
            "dotnet",
            []string{driver}.Concat(arguments).Concat([]string{"--app", "Library.csproj"}).ToArray()
        )
        Assert.True(selected.ExitCode == 0, selected.Output)
        Assert.Empty(Directory.GetFiles(output))
        let unknown = ProcessRunner.Run(
            "dotnet",
            []string{driver}.Concat(arguments).Concat([]string{"--app", "Missing.csproj"}).ToArray()
        )
        Assert.Equal(1, unknown.ExitCode)
        Assert.Contains("found no app 'Missing.csproj'", unknown.Output, StringComparison.Ordinal)
        let unselected = ProcessRunner.Run("dotnet", []string{driver}.Concat(arguments).ToArray())
        Assert.Equal(1, unselected.ExitCode)
        Assert.Contains("found no test projects", unselected.Output, StringComparison.Ordinal)
    }

    /// The real `dotnet test --list-tests` shape parses into its names.
    @Fact
    func Oracle_ParsesListTestsOutput() {
        const output = `Test run for /repo/out/bin/Release/Own.Tests/Own.Tests.dll (.NETCoreApp,Version=v10.0)
The following Tests are available:
    Own.Tests.A.Works
    Own.Tests.A.Adds(x: 1)`
        let names = CSharpTestOracle.ParseListTestsOutput(output)
        Assert.Equal([]string{"Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)"}, names)
    }

    /// Review finding: a multi-targeted project's listing has one block per framework; all count.
    @Fact
    func Oracle_ParsesEveryListingBlock() {
        const output = `Test run for /repo/out/bin/Release/net9.0/Own.Tests.dll (.NETCoreApp,Version=v9.0)
The following Tests are available:
    Own.Tests.A.Works
Test run for /repo/out/bin/Release/net10.0/Own.Tests.dll (.NETCoreApp,Version=v10.0)
The following Tests are available:
    Own.Tests.A.Works`
        Assert.Equal([]string{"Own.Tests.A.Works", "Own.Tests.A.Works"}, CSharpTestOracle.ParseListTestsOutput(output))
    }

    /// A listing that failed, or listed nothing, must never become an empty
    /// oracle: an empty oracle would make the per-name check a check of nothing.
    @Theory
    @InlineData("The argument /repo/Own.Tests.dll is invalid.")
    @InlineData("The following Tests are available:\n")
    @InlineData("")
    func Oracle_NoHeaderOrNoNames_Throws(output string) {
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CSharpTestOracle.ParseListTestsOutput(output)
            }
        )
    }

    /// An oracle round-trips; an absent one loads as null; a mislabelled one is rejected.
    @Fact
    func Oracle_RoundTripsAndRejectsAnotherAppsFile() {
        let dir = NewDirectory()
        CSharpTestOracle.Create(AppId, OracleNames).Write(dir)
        let loaded = CSharpTestOracle.LoadOrNull(dir, AppId)!!
        Assert.NotNull(loaded)
        Assert.Equal(OracleNames.OrderBy((n string) -> n, StringComparer.Ordinal), loaded.Tests)
        Assert.Null(CSharpTestOracle.LoadOrNull(dir, "test/Other.Tests/Other.Tests.csproj"))
        File.Copy(
            Path.Combine(dir, CSharpTestOracle.FileNameFor(AppId)),
            Path.Combine(dir, CSharpTestOracle.FileNameFor("test/Other.Tests/Other.Tests.csproj"))
        )
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CSharpTestOracle.LoadOrNull(dir, "test/Other.Tests/Other.Tests.csproj")
            }
        )
    }

    /// Review finding: two app ids that sanitize to the same string must not
    /// share an oracle file, or one app would be checked against the other's
    /// cases.
    @Fact
    func Oracle_FileNames_DoNotCollideForIdsThatSanitizeAlike() {
        Assert.NotEqual(
            CSharpTestOracle.FileNameFor("a/b_c/X.Tests.csproj"),
            CSharpTestOracle.FileNameFor("a_b/c/X.Tests.csproj")
        )
    }

    /// Review finding: capture and the stage share one classification, and the
    /// evaluated MSBuild `IsTestProject` alone makes a project a mirrored
    /// test project even when its file does not say so.
    @Fact
    func MirroredTestClassification_HonoursTheEvaluatedProperty() {
        let dir = NewDirectory()
        let plain = Path.Combine(dir, "Plain.csproj")
        File.WriteAllText(plain, "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        Assert.False(TestParityStage.IsMirroredTestProject(false, plain))
        Assert.True(TestParityStage.IsMirroredTestProject(true, plain))
    }

    /// Review finding: a truncated or edited oracle (count disagrees with its list) is rejected.
    @Fact
    func Oracle_CountMismatch_IsRejected() {
        let dir = NewDirectory()
        let oracle = CSharpTestOracle.Create(AppId, OracleNames)
        oracle.TestCount = OracleNames.Length + 1
        oracle.Write(dir)
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CSharpTestOracle.LoadOrNull(dir, AppId)
            }
        )
    }

    // ---------------------------------------------------------------------
    // The baseline of justified differences.
    // ---------------------------------------------------------------------
    /// Every entry must be scoped, typed, explained and tracked.
    @Fact
    func Baseline_RejectsUnjustifiedEntries() {
        let entries = List[TestNameParityBaselineEntry]{
            TestNameParityBaselineEntry{
                App: AppId,
                Kind: "missing",
                Test: "Own.Tests.A.Works",
                Reason: "short",
                Issue: "#1"
            },
            TestNameParityBaselineEntry{
                App: AppId,
                Kind: "missing",
                Test: "Own.Tests.A.Works2",
                Reason: String('r', 30),
                Issue: nil
            },
            TestNameParityBaselineEntry{
                App: AppId,
                Kind: "gone",
                Test: "Own.Tests.A.Works3",
                Reason: String('r', 30),
                Issue: "#1"
            },
            TestNameParityBaselineEntry{
                App: "test/Own.Tests",
                Kind: "extra",
                Test: "Own.Tests.A.Works4",
                Reason: String('r', 30),
                Issue: "#1"
            },
            TestNameParityBaselineEntry{
                App: AppId,
                Kind: "rows",
                Test: "Own.Tests.A.Adds(x: 1)",
                Reason: String('r', 30),
                Issue: "#1"
            }
        }
        let errors = TestNameParityBaseline.ValidateEntries(entries)
        Assert.Equal(5, errors.Count)
        Assert.Contains(errors, (e string) -> e.Contains("'reason'", StringComparison.Ordinal))
        Assert.Contains(errors, (e string) -> e.Contains("'issue'", StringComparison.Ordinal))
        Assert.Contains(errors, (e string) -> e.Contains("'kind'", StringComparison.Ordinal))
        Assert.Contains(errors, (e string) -> e.Contains("'app'", StringComparison.Ordinal))
        Assert.Contains(errors, (e string) -> e.Contains("without an argument list", StringComparison.Ordinal))
    }

    /// An entry explains exactly its own difference; an unused entry is stale.
    @Fact
    func Baseline_ExplainsListedDifference_AndReportsStaleEntries() {
        let baseline = Baseline(
            Issue4633TestNameParityTests.Entry("missing", "Own.Tests.A.Adds(x: 2)"),
            Issue4633TestNameParityTests.Entry("extra", "Own.Tests.B.NoLongerThere")
        )
        let result = TestNameParity.Compare(OracleNames, Passed("Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)"))
        let verdict = baseline.Evaluate(AppId, result)
        Assert.False(verdict.IsMatch)
        Assert.Equal([]string{"Own.Tests.B.Works"}, verdict.UnexplainedMissing)
        Assert.Equal([]string{"missing: Own.Tests.A.Adds(x: 2)"}, verdict.Explained)
        Assert.Equal("Own.Tests.B.NoLongerThere", Assert.Single(verdict.StaleEntries).Test)
    }

    /// A `rows` entry covers a rendering difference (same number of rows on
    /// both sides) and nothing more: a row that is actually lost stays a failure.
    @Fact
    func Baseline_RowsEntry_ExcusesRenderingNotLoss() {
        let baseline = Baseline(Issue4633TestNameParityTests.Entry("rows", "Own.Tests.A.Adds"))
        let oracle[]string = []string{"Own.Tests.A.Adds(x: 1.5)", "Own.Tests.A.Adds(x: 2.5)"}
        let rendered = baseline.Evaluate(
            AppId,
            TestNameParity.Compare(oracle, Passed("Own.Tests.A.Adds(x: 1,5)", "Own.Tests.A.Adds(x: 2,5)"))
        )
        let lost = baseline.Evaluate(AppId, TestNameParity.Compare(oracle, Passed("Own.Tests.A.Adds(x: 1,5)")))
        Assert.True(rendered.IsMatch)
        Assert.Empty(rendered.StaleEntries)
        Assert.Contains("rows: Own.Tests.A.Adds (2 row(s) render differently)", rendered.Explained)
        Assert.False(lost.IsMatch)
        Assert.Equal(2, lost.UnexplainedMissing.Count)
    }

    /// A `rows` entry does not hide a lost row behind an unrelated added
    /// one with the same count: the rows must pair up by argument structure.
    @Fact
    func Baseline_RowsEntry_RequiresMatchingArgumentStructure() {
        let baseline = Baseline(Issue4633TestNameParityTests.Entry("rows", "Own.Tests.A.Adds"))
        let oracle[]string = []string{"Own.Tests.A.Adds(x: 1.5)"}
        let swapped = baseline.Evaluate(AppId, TestNameParity.Compare(oracle, Passed("Own.Tests.A.Adds(y: 2, z: 3)")))
        Assert.False(swapped.IsMatch)
        Assert.Single(swapped.UnexplainedMissing)
        Assert.Single(swapped.UnexplainedExtra)
    }

    /// Review finding: names are a multiset, so one exact entry excuses ONE
    /// occurrence. A second identical missing row needs `count`.
    @Fact
    func Baseline_ExactEntry_ExcusesOneOccurrenceUnlessCounted() {
        let oracle[]string = []string{
            "Own.Tests.A.Long(s: \"aaa\"···)",
            "Own.Tests.A.Long(s: \"aaa\"···)",
            "Own.Tests.A.Works"
        }
        let result = TestNameParity.Compare(oracle, Passed("Own.Tests.A.Works"))
        let once = Baseline(Issue4633TestNameParityTests.Entry("missing", "Own.Tests.A.Long(s: \"aaa\"···)")).Evaluate(
            AppId,
            result
        )
        let twice = Issue4633TestNameParityTests.Entry("missing", "Own.Tests.A.Long(s: \"aaa\"···)")
        twice.Count = 2
        let counted = Baseline(twice).Evaluate(AppId, result)
        Assert.Single(once.UnexplainedMissing)
        Assert.True(counted.IsMatch)
        Assert.Empty(counted.StaleEntries)
    }

    /// Review finding: names are matched exactly, so `?` and `*` in a theory
    /// row's argument are literal characters; an entry never matches anything
    /// but the one name it spells.
    @Fact
    func Baseline_WildcardCharactersAreLiteral() {
        let baseline = Baseline(Issue4633TestNameParityTests.Entry("missing", "Own.Tests.A.Ask(q: \"why?\")"))
        let oracle[]string = []string{"Own.Tests.A.Ask(q: \"why?\")", "Own.Tests.A.Ask(q: \"whyX\")"}
        let verdict = baseline.Evaluate(AppId, TestNameParity.Compare(oracle, Passed()))
        Assert.Equal([]string{"Own.Tests.A.Ask(q: \"whyX\")"}, verdict.UnexplainedMissing)
    }

    /// A renamed-argument entry pairs a row with its renamed twin and nothing
    /// else: a row whose VALUE also differs stays unexplained.
    @Fact
    func Baseline_RenamedArgument_PairsOnlyRenamedTwins() {
        let entry = Issue4633TestNameParityTests.Entry("renamed-argument", "Own.Tests.A.Narrow")
        entry.Argument = "scope"
        entry.RenamedTo = "scope_"
        let oracle[]string = []string{
            "Own.Tests.A.Narrow(shape: \"x\", scope: \"function\")",
            "Own.Tests.A.Narrow(shape: \"y\", scope: \"top\")"
        }
        let verdict = Baseline(entry).Evaluate(
            AppId,
            TestNameParity.Compare(
                oracle,
                Passed(
                    "Own.Tests.A.Narrow(shape: \"x\", scope_: \"function\")",
                    "Own.Tests.A.Narrow(shape: \"y\", scope_: \"OTHER\")"
                )
            )
        )
        Assert.Equal([]string{"Own.Tests.A.Narrow(shape: \"y\", scope: \"top\")"}, verdict.UnexplainedMissing)
        Assert.Equal([]string{"Own.Tests.A.Narrow(shape: \"y\", scope_: \"OTHER\")"}, verdict.UnexplainedExtra)
        Assert.Contains("renamed-argument: Own.Tests.A.Narrow(shape: \"x\", scope: \"function\")", verdict.Explained)
        Assert.Empty(verdict.StaleEntries)
    }

    /// The checked-in baseline loads: every entry in it is justified and tracked.
    @Fact
    func CheckedInBaseline_IsValid() {
        let path = Path.Combine(RepoRoot(), TestNameParityBaseline.DefaultRelativePath)
        Assert.True(File.Exists(path), path)
        TestNameParityBaseline.Load(path)
    }

    // ---------------------------------------------------------------------
    // The stage verdict (ADR-0154 witnesses).
    // ---------------------------------------------------------------------
    /// The discriminating witness. The run exits 0 and executes more cases than
    /// the C# original has [Fact] methods, so the count-only gate PASSES it (see
    /// (cref:Stage_WithoutOracle_KeepsCountOnlyAndSaysSo)). It lost a
    /// theory row, so per-name parity must FAIL it.
    @Fact
    func Stage_LostTheoryRow_FailsPerNameParity() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works")
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        let artifact = Assert.Single(outcome.Artifacts)
        Assert.Equal("TEST-NAME-PARITY", artifact.Diagnostic!!.Id)
        Assert.Contains("Own.Tests.A.Adds(x: 2)", artifact.Diagnostic!!.Message, StringComparison.Ordinal)
        Assert.Equal(1, context.TestNameParity.Missing)
        Assert.True(File.Exists(Path.Combine(context.ArtifactDir, TestParityStage.TestNameParityFileName)))
    }

    /// The other direction: an identical case set passes and records its counts.
    @Fact
    func Stage_IdenticalCases_PassesAndRecordsCounts() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        WriteTrx(context, OracleNames)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Empty(outcome.Artifacts)
        Assert.Equal(TestNameParitySummary.PerNameMode, context.TestNameParity.Mode)
        Assert.Equal(4, context.TestNameParity.CSharpCases)
        Assert.Equal(4, context.TestNameParity.MigratedCases)
        Assert.Equal(4, context.TestNameParity.Matched)
    }

    /// Without an oracle directory the stage keeps the count-only check, and the
    /// lost row above passes, which is exactly the blind spot. The run record
    /// says `count-only` so it can never be mistaken for per-name parity.
    @Fact
    func Stage_WithoutOracle_KeepsCountOnlyAndSaysSo() {
        let context = Issue4633TestNameParityTests.Context(withOracle: false)
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works")
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Equal(TestNameParitySummary.CountOnlyMode, context.TestNameParity.Mode)
    }

    /// Review finding: a run that misses the [Fact] floor still gets its
    /// per-name summary and diff, so every completed run is auditable.
    @Fact
    func Stage_BelowTheFactFloor_StillRecordsNameParity() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        WriteTrx(context, "Own.Tests.A.Works")
        const output = "Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 1 s - Own.Tests.dll (net10.0)"
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, output, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "NO-TESTS-RAN")
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "TEST-NAME-PARITY")
        Assert.NotNull(context.TestNameParity)
        Assert.Equal(3, context.TestNameParity.Missing)
    }

    /// A configured oracle directory with no file for this app fails; it never falls back.
    @Fact
    func Stage_MissingOracleFile_Fails() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        File.Delete(Path.Combine(context.Options.CSharpTestOracleDirectory!!, CSharpTestOracle.FileNameFor(AppId)))
        WriteTrx(context, OracleNames)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Equal("TEST-ORACLE-MISSING", Assert.Single(outcome.Artifacts).Diagnostic!!.Id)
    }

    /// Review finding: a failure whose message names an absolute path (here
    /// the oracle directory) still fingerprints the same on every runner.
    @Fact
    func Stage_FailureFingerprint_DoesNotDependOnPaths() {
        let Fingerprint = func () string {
            let context = Issue4633TestNameParityTests.Context(withOracle: true)
            File.Delete(Path.Combine(context.Options.CSharpTestOracleDirectory!!, CSharpTestOracle.FileNameFor(AppId)))
            WriteTrx(context, OracleNames)
            return Assert.Single(
                TestParityStage().EvaluateMirroredTestRun(
                    context,
                    ProcessRunResult(0, GreenRunOutput, string.Empty, false)
                )
                    .Artifacts
            )
                .Fingerprint
        }
        Assert.Equal(Fingerprint(), Fingerprint())
    }

    /// A run that left no TRX cannot be compared and fails.
    @Fact
    func Stage_MissingTrx_Fails() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Equal("TEST-RESULTS-UNREADABLE", Assert.Single(outcome.Artifacts).Diagnostic!!.Id)
    }

    /// Review finding: a TRX result without a name fails closed instead of being dropped.
    @Fact
    func Stage_UnnamedResult_FailsClosed() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        WriteTrx(context, OracleNames.Append(" ").ToArray())
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal("TEST-RESULTS-UNREADABLE", Assert.Single(outcome.Artifacts).Diagnostic!!.Id)
    }

    /// Review finding: a multi-targeted run writes one TRX per framework; all
    /// of them are compared, so the oracle's per-framework duplicates match.
    @Fact
    func Stage_EveryTrxFileCounts() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)")
        let directory = SdkCompileRunner.MirroredTestResultsDirectory(context.ArtifactDir)
        File.Move(Path.Combine(directory, "parity.trx"), Path.Combine(directory, "parity_net9.trx"))
        WriteTrx(context, "Own.Tests.A.Adds(x: 2)", "Own.Tests.B.Works")
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Equal(4, context.TestNameParity.MigratedCases)
    }

    /// Zero migrated results where the C# original has cases is a failure.
    @Fact
    func Stage_ZeroResults_Fails() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        WriteTrx(context)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        let artifact = Assert.Single(outcome.Artifacts)
        Assert.Contains("ZERO", artifact.Diagnostic!!.Message, StringComparison.Ordinal)
    }

    /// The failure allow-list excuses a failing case, never a missing one: a run
    /// whose failures are all allow-listed still fails when a case is lost.
    @Fact
    func Stage_AllowListedFailures_DoNotExcuseAMissingCase() {
        let context = Issue4633TestNameParityTests.Context(withOracle: true)
        context.Options.TestParityAllowList = TestParityAllowList.Parse(`{ "entries": [ { "app": "test/Own.Tests/Own.Tests.csproj", "test": "A.Works",
  "reason": "fails for a documented policy reason in this fixture", "issue": "#4633" } ] }`)
        WriteTrx(context, "Own.Tests.A.Works", "Own.Tests.A.Adds(x: 1)", "Own.Tests.B.Works")
        const output = `  Failed Own.Tests.A.Works [3 ms]
Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 1 s - Own.Tests.dll (net10.0)`
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(1, output, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Equal("TEST-NAME-PARITY", Assert.Single(outcome.Artifacts).Diagnostic!!.Id)
    }

    // ---------------------------------------------------------------------
    // Plumbing: the summary survives the shard merge; validate is fail-safe.
    // ---------------------------------------------------------------------
    /// The per-name counts survive build/merge-selfmig-runs.py into the merged run.
    @Fact
    func Merge_CarriesTestNameParityFromTheShard() {
        let dir = NewDirectory()
        let migratePath = Path.Combine(dir, "migrate.json")
        let shardPath = Path.Combine(dir, "shard.json")
        let outPath = Path.Combine(dir, "merged.json")
        File.WriteAllText(migratePath, `{ "runId": "r1", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
  "succeeded": true, "apps": [ { "appId": "test/Own.Tests/Own.Tests.csproj",
  "succeeded": true, "stages": [ { "stage": "translate", "status": "passed",
  "artifactCount": 0 } ], "artifacts": [], "fingerprints": [] } ] }`)
        File.WriteAllText(shardPath, `{ "runId": "r2", "timestamp": "t", "gscVersion": "v", "gscPath": "p",
  "succeeded": true, "apps": [ { "appId": "test/Own.Tests/Own.Tests.csproj",
  "succeeded": true, "stages": [ { "stage": "test-parity", "status": "passed",
  "artifactCount": 0 } ], "artifacts": [], "fingerprints": [],
  "testNameParity": { "mode": "per-name", "csharpCases": 10920, "migratedCases": 10920 } } ] }`)
        let run = ProcessRunner.Run(
            "python3",
            []string{
                Path.Combine(RepoRoot(), "build", "merge-selfmig-runs.py"),
                "--migrate",
                migratePath,
                "--out",
                outPath,
                shardPath
            }
        )
        Assert.True(run.ExitCode == 0, run.Output)
        let merged = File.ReadAllText(outPath)
        Assert.Contains("\"csharpCases\": 10920", merged, StringComparison.Ordinal)
        Assert.Contains("\"per-name\"", merged, StringComparison.Ordinal)
    }

    /// The shard command refuses to run without either the oracle or an
    /// explicit opt-out, so dropping one flag from the gate script cannot
    /// silently restore the count-only check.
    @Fact
    async func Validate_RequiresTheOracleOrAnExplicitOptOut() {
        let dir = NewDirectory()
        let originalError = Console.Error
        let captured = StringWriter()
        Console.SetError(captured)
        var exit int32
        try {
            exit = await ValidateCommand.RunAsync([]string{"--corpus", dir, "--migrated", dir})
        } finally {
            Console.SetError(originalError)
        }
        Assert.Equal(1, exit)
        Assert.Contains("--csharp-test-oracle", captured.ToString(), StringComparison.Ordinal)
    }

    /// Issue #4633 raised the budget ceiling: nightly 36906270739 measured the
    /// migrated Compiler.Tests run (4,492 declared facts) at 4,941 s, 91% of the
    /// old 90-minute ceiling. Its budget must leave at least 20% headroom over
    /// that measurement.
    @Fact
    func Budget_CompilerTestsHasHeadroomOverItsMeasuredRun() {
        let budget = SdkCompileRunner.MirroredTestRunTimeoutFor(4492)
        Assert.True(
            budget.TotalSeconds >= float64(4941.0) * 1.2,
            "Compiler.Tests' budget $budget leaves under 20% headroom over its measured 4,941 s."
        )
    }

    shared {
        private const AppId string = "test/Own.Tests/Own.Tests.csproj"
        private const GreenRunOutput string = "Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4, Duration: 1 s - Own.Tests.dll (net10.0)"
        private let OracleNames[]string = []string{
            "Own.Tests.A.Works",
            "Own.Tests.A.Adds(x: 1)",
            "Own.Tests.A.Adds(x: 2)",
            "Own.Tests.B.Works"
        }
        private func Passed(names ...string)[]TestCaseOutcome -> names.Select(
            (name string) -> TestCaseOutcome(name, "Passed")
        )
            .ToArray()

        private func Entry(kind string, test string) TestNameParityBaselineEntry -> TestNameParityBaselineEntry{
            App: AppId,
            Kind: kind,
            Test: test,
            Reason: "a justified difference used by this test fixture",
            Issue: "#4633"
        }

        private func Baseline(
            entries ...TestNameParityBaselineEntry
        ) TestNameParityBaseline -> TestNameParityBaseline.Parse(
            JsonSerializer.Serialize(TestNameParityBaselineDocument{Entries: entries.ToList()})
        )

        private func Context(withOracle bool) StageExecutionContext {
            let dir = NewDirectory()
            let csPath = Path.Combine(dir, "Own.cs")
            File.WriteAllText(
                csPath,
                "using Xunit; public class A { [Fact] public void Works() { } } public class B { [Fact] public void Works() { } }"
            )
            let projectPath = Path.Combine(dir, "Own.Tests.csproj")
            File.WriteAllText(projectPath, "<Project Sdk=\"Microsoft.NET.Sdk\" />")
            let app = CorpusApp(AppId, projectPath, TargetKind.Library)
            let options = PipelineOptions{OutputRoot: dir}
            if withOracle {
                let oracleDir = Path.Combine(dir, "oracle")
                CSharpTestOracle.Create(AppId, OracleNames).Write(oracleDir)
                options.CSharpTestOracleDirectory = oracleDir
            }
            let triage = TriageBuilder("run_1", "2026-10-01T00:00:00Z", "0.0.0", app.Id)
            let context = StageExecutionContext(app, options, GscInvoker("gsc.dll"), dir, triage)
            context.EmittedFiles.Add(EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty))
            return context
        }

        private func WriteTrx(context StageExecutionContext, names ...string) {
            let trx = StringBuilder()
            trx.AppendLine("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
            trx.AppendLine("<TestRun xmlns=\"http://microsoft.com/schemas/VisualStudio/TeamTest/2010\"><Results>")
            for name in names {
                trx
                    .Append("<UnitTestResult testName=\"")
                    .Append(SecurityElement.Escape(name))
                    .AppendLine("\" outcome=\"Passed\" />")
            }
            trx.AppendLine("</Results></TestRun>")
            let directory = SdkCompileRunner.MirroredTestResultsDirectory(context.ArtifactDir)
            Directory.CreateDirectory(directory)
            let path = Path.Combine(directory, "parity.trx")
            File.WriteAllText(path, trx.ToString())
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
            let path = Path.Combine(
                AppContext.BaseDirectory,
                "issue-4633-test-name-parity",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(path)
            return path
        }
    }
}
