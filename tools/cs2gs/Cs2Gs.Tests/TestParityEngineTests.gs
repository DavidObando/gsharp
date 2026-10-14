// <copyright file="TestParityEngineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.Json
import Xunit

/// Tests for the stage-4 (ADR-0115 §C/§E) parity oracle-comparison ENGINE: the
/// (cref:BaselineTestsOracle) loader, the (cref:TrxParser), the
/// (cref:TestParityComparison) set-difference, and the
/// (cref:StdoutParity) oracle, plus the `test-parity-failure` triage
/// artifact shape, labels, and fingerprint. These are deterministic and
/// fixture-driven (no live `dotnet test` build), exercising the heart of the
/// stage independently of the not-yet-ready library translation path.
open class TestParityEngineTests {
    /// The baseline oracle loader round-trips the committed
    /// `baseline.sample.json` fixture: schema/app/framework and per-test
    /// name/outcome records (including theory case suffixes).
    @Fact
    func BaselineOracle_Load_ParsesFixture() {
        let oracle = BaselineTestsOracle.Load(TestParityEngineTests.Fixture("baseline.sample.json"))!!
        Assert.Equal("1.0", oracle.SchemaVersion)
        Assert.Equal("Sample.Tests", oracle.App)
        Assert.Equal("xunit", oracle.Framework)
        Assert.Equal(4, oracle.Total)
        Assert.Equal(4, oracle.Passed)
        Assert.Equal(4, oracle.Tests!!.Count)
        Assert.Contains(
            oracle.Tests!!,
            (t TestCaseOutcome) -> t.Name == "Sample.Tests.CalculatorTests.Add_Cases(a: 1, b: 2, expected: 3)" &&
                t.Outcome == "Passed"
        )
    }

    /// A malformed baseline JSON surfaces a clear (cref:InvalidOperationException).
    @Fact
    func BaselineOracle_Parse_RejectsMalformedJson() {
        Assert.Throws[InvalidOperationException](
            func () object? {
                return BaselineTestsOracle.Parse("{ this is not json")
            }
        )
    }

    /// The TRX parser extracts only the `UnitTestResult` rows (ignoring the
    /// `ResultSummary` banner whose outcome is `Completed`), reads the
    /// `testName`/`outcome` attributes, and sorts by name — matching the
    /// shape `corpus/trx-to-baseline.py` records.
    @Fact
    func TrxParser_ParsesUnitTestResults_SkipsSummary() {
        let results = TrxParser.ParseFile(TestParityEngineTests.Fixture("sample.pass.trx"))
        Assert.Equal(4, results.Count)
        Assert.DoesNotContain(results, (r TestCaseOutcome) -> r.Outcome == "Completed")
        Assert.All(results, (r TestCaseOutcome) -> Assert.Equal("Passed", r.Outcome))
        // Sorted by name ordinal.
        let names = results.Select((r TestCaseOutcome) -> r.Name!!).ToArray()
        let sorted = names.OrderBy((n string) -> n, StringComparer.Ordinal).ToArray()
        Assert.Equal(sorted, names)
    }

    /// Exact-match parity: the G# TRX equals the baseline, so the comparison
    /// yields zero differences and (cref:TestParityResult.IsMatch) is true.
    /// Theory inline-data case names compare verbatim, so the two
    /// `Add_Cases(...)` cases each match.
    @Fact
    func Compare_ExactMatch_IsParity() {
        let oracle = BaselineTestsOracle.Load(TestParityEngineTests.Fixture("baseline.sample.json"))!!
        let actual = TrxParser.ParseFile(TestParityEngineTests.Fixture("sample.pass.trx"))
        let result = TestParityComparison.Compare(oracle.Tests, actual)
        Assert.True(result.IsMatch)
        Assert.Empty(result.Differences)
    }

    /// A failed G# test (outcome differs from the baseline `Passed`) yields a
    /// single (cref:TestDiffKind.OutcomeMismatch) diff naming the test.
    @Fact
    func Compare_FailedTest_YieldsOutcomeMismatch() {
        let oracle = BaselineTestsOracle.Load(TestParityEngineTests.Fixture("baseline.sample.json"))!!
        let actual = TrxParser.ParseFile(TestParityEngineTests.Fixture("sample.failed.trx"))
        let result = TestParityComparison.Compare(oracle.Tests, actual)
        let diff = Assert.Single(result.Differences)
        Assert.Equal(TestDiffKind.OutcomeMismatch, diff.Kind)
        Assert.Equal("Sample.Tests.CalculatorTests.Subtract_Returns_Difference", diff.Name)
        Assert.Equal("Passed", diff.ExpectedOutcome)
        Assert.Equal("Failed", diff.ActualOutcome)
    }

    /// A baseline test the G# run did not produce yields a
    /// (cref:TestDiffKind.Missing) diff with a null actual outcome.
    @Fact
    func Compare_MissingTest_YieldsMissing() {
        let expected = []TestCaseOutcome{TestCaseOutcome("N.C.A", "Passed"), TestCaseOutcome("N.C.B", "Passed")}
        let actual = []TestCaseOutcome{TestCaseOutcome("N.C.A", "Passed")}
        let result = TestParityComparison.Compare(expected, actual)
        let diff = Assert.Single(result.Differences)
        Assert.Equal(TestDiffKind.Missing, diff.Kind)
        Assert.Equal("N.C.B", diff.Name)
        Assert.Null(diff.ActualOutcome)
    }

    /// A G# test not present in the baseline yields a
    /// (cref:TestDiffKind.Extra) diff with a null expected outcome.
    @Fact
    func Compare_ExtraTest_YieldsExtra() {
        let expected = []TestCaseOutcome{TestCaseOutcome("N.C.A", "Passed")}
        let actual = []TestCaseOutcome{TestCaseOutcome("N.C.A", "Passed"), TestCaseOutcome("N.C.Z", "Passed")}
        let result = TestParityComparison.Compare(expected, actual)
        let diff = Assert.Single(result.Differences)
        Assert.Equal(TestDiffKind.Extra, diff.Kind)
        Assert.Equal("N.C.Z", diff.Name)
        Assert.Null(diff.ExpectedOutcome)
    }

    /// A theory inline-data case whose name matches exactly (including the
    /// `(arg: val, ...)` suffix) is parity; changing one case's args makes it
    /// a missing+extra pair, proving case-name granularity.
    @Fact
    func Compare_TheoryCaseName_ComparesVerbatim() {
        let expected = []TestCaseOutcome{
            TestCaseOutcome("N.C.T(a: 1, expected: 2)", "Passed"),
            TestCaseOutcome("N.C.T(a: 2, expected: 4)", "Passed")
        }
        let matching = []TestCaseOutcome{
            TestCaseOutcome("N.C.T(a: 1, expected: 2)", "Passed"),
            TestCaseOutcome("N.C.T(a: 2, expected: 4)", "Passed")
        }
        let shifted = []TestCaseOutcome{
            TestCaseOutcome("N.C.T(a: 1, expected: 2)", "Passed"),
            TestCaseOutcome("N.C.T(a: 3, expected: 6)", "Passed")
        }
        Assert.True(TestParityComparison.Compare(expected, matching).IsMatch)
        let drift = TestParityComparison.Compare(expected, shifted)
        Assert.False(drift.IsMatch)
        Assert.Contains(
            drift.Differences,
            (d TestParityDiff) -> d.Kind == TestDiffKind.Missing && d.Name.Contains("a: 2")
        )
        Assert.Contains(
            drift.Differences,
            (d TestParityDiff) -> d.Kind == TestDiffKind.Extra && d.Name.Contains("a: 3")
        )
    }

    /// An `OutcomeMismatch` diff produces a `test-parity-failure`
    /// artifact carrying the stage/category, a `TESTPARITY-OutcomeMismatch`
    /// diagnostic id, the failing test name as the construct kind, labels
    /// `Oats` + `bug`, and a stable `sha256:` fingerprint.
    @Fact
    func TestFailureArtifact_HasShapeLabelsAndFingerprint() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample.Tests")
        let diff = TestParityDiff(
            TestDiffKind.OutcomeMismatch,
            "Sample.Tests.CalculatorTests.Subtract_Returns_Difference",
            "Passed",
            "Failed"
        )
        let artifact = builder.TestParityTestFailure(diff, "corpus_Sample.Tests/CalculatorTests.gs")
        let json = JsonSerializer.Serialize(artifact, TriageSerialization.Options)
        using let doc = JsonDocument.Parse(json)
        let root = doc.RootElement
        Assert.Equal("test-parity", root.GetProperty("stage").GetString())
        Assert.Equal("test-parity-failure", root.GetProperty("category").GetString())
        Assert.Equal("TESTPARITY-OutcomeMismatch", root.GetProperty("diagnostic").GetProperty("id").GetString())
        Assert.Equal(
            "Sample.Tests.CalculatorTests.Subtract_Returns_Difference",
            root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString()
        )
        let labels = root
            .GetProperty("suggestedIssue")
            .GetProperty("labels")
            .EnumerateArray()
            .Select((e JsonElement) -> e.GetString()!!)
            .ToArray()
        Assert.Contains("Oats", labels)
        Assert.Contains("bug", labels)
        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal)
    }

    /// The per-test fingerprint splits on the test name and the diff kind, so the
    /// pipeline emits one artifact per differing test.
    @Fact
    func TestFailureArtifact_Fingerprint_SplitsPerTest() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample.Tests")
        let a = builder.TestParityTestFailure(TestParityDiff(TestDiffKind.OutcomeMismatch, "N.C.A", "Passed", "Failed"))
        let sameAgain = builder.TestParityTestFailure(
            TestParityDiff(TestDiffKind.OutcomeMismatch, "N.C.A", "Passed", "Failed")
        )
        let differentTest = builder.TestParityTestFailure(
            TestParityDiff(TestDiffKind.OutcomeMismatch, "N.C.B", "Passed", "Failed")
        )
        let differentKind = builder.TestParityTestFailure(TestParityDiff(TestDiffKind.Missing, "N.C.A", "Passed", nil))
        Assert.Equal(a.Fingerprint, sameAgain.Fingerprint)
        Assert.NotEqual(a.Fingerprint, differentTest.Fingerprint)
        Assert.NotEqual(a.Fingerprint, differentKind.Fingerprint)
    }

    /// Stdout parity normalizes CRLF→LF and tolerates exactly one unavoidable
    /// terminal newline (the L1 recipe), so a golden and an actual that differ
    /// only in line endings and that single trailing newline still match.
    /// Issue #1749 mode 2: this must NOT extend to collapsing *every* trailing
    /// newline — see (cref:StdoutParityNormalizeTests) for the case this
    /// regressed (extra trailing blank lines must still be detected).
    @Fact
    func StdoutParity_Normalizes_LineEndingsAndSingleTrailingNewline() {
        let result = StdoutParity.Compare(`line1
line2
`, "line1\r\nline2\r\n")
        Assert.True(result.IsMatch)
    }

    /// A stdout mismatch isolates the first differing line (1-based) and both
    /// sides, and yields a `test-parity-failure` artifact with the
    /// `STDOUT-MISMATCH` id, `ProgramStdout` construct kind, labels
    /// `Oats` + `bug`, and a stable fingerprint.
    @Fact
    func StdoutParity_Mismatch_ProducesArtifact() {
        let result = StdoutParity.Compare(`hello
world
`, `hello
there
`)
        Assert.False(result.IsMatch)
        Assert.Equal(2, result.LineNumber)
        Assert.Equal("world", result.ExpectedLine)
        Assert.Equal("there", result.ActualLine)
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/L1-Console")
        let artifact = builder.TestParityStdoutFailure(result, "corpus_L1-Console/Program.gs")
        let json = JsonSerializer.Serialize(artifact, TriageSerialization.Options)
        using let doc = JsonDocument.Parse(json)
        let root = doc.RootElement
        Assert.Equal("test-parity", root.GetProperty("stage").GetString())
        Assert.Equal("test-parity-failure", root.GetProperty("category").GetString())
        Assert.Equal("STDOUT-MISMATCH", root.GetProperty("diagnostic").GetProperty("id").GetString())
        Assert.Equal("ProgramStdout", root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString())
        let labels = root
            .GetProperty("suggestedIssue")
            .GetProperty("labels")
            .EnumerateArray()
            .Select((e JsonElement) -> e.GetString()!!)
            .ToArray()
        Assert.Contains("Oats", labels)
        Assert.Contains("bug", labels)
        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal)
    }

    shared {
        private func Fixture(fileName string) string {
            return Path.Combine(AppContext.BaseDirectory, "Fixtures", "TestParity", fileName)
        }
    }
}
