// <copyright file="TestParityEngineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for the stage-4 (ADR-0115 §C/§E) parity oracle-comparison ENGINE: the
/// <see cref="BaselineTestsOracle"/> loader, the <see cref="TrxParser"/>, the
/// <see cref="TestParityComparison"/> set-difference, and the
/// <see cref="StdoutParity"/> oracle, plus the <c>test-parity-failure</c> triage
/// artifact shape, labels, and fingerprint. These are deterministic and
/// fixture-driven (no live <c>dotnet test</c> build), exercising the heart of the
/// stage independently of the not-yet-ready library translation path.
/// </summary>
public class TestParityEngineTests
{
    /// <summary>
    /// The baseline oracle loader round-trips the committed
    /// <c>baseline.sample.json</c> fixture: schema/app/framework and per-test
    /// name/outcome records (including theory case suffixes).
    /// </summary>
    [Fact]
    public void BaselineOracle_Load_ParsesFixture()
    {
        BaselineTestsOracle oracle = BaselineTestsOracle.Load(Fixture("baseline.sample.json"));

        Assert.Equal("1.0", oracle.SchemaVersion);
        Assert.Equal("Sample.Tests", oracle.App);
        Assert.Equal("xunit", oracle.Framework);
        Assert.Equal(4, oracle.Total);
        Assert.Equal(4, oracle.Passed);
        Assert.Equal(4, oracle.Tests.Count);
        Assert.Contains(
            oracle.Tests,
            t => t.Name == "Sample.Tests.CalculatorTests.Add_Cases(a: 1, b: 2, expected: 3)"
                && t.Outcome == "Passed");
    }

    /// <summary>
    /// A malformed baseline JSON surfaces a clear <see cref="InvalidOperationException"/>.
    /// </summary>
    [Fact]
    public void BaselineOracle_Parse_RejectsMalformedJson()
    {
        Assert.Throws<InvalidOperationException>(() => BaselineTestsOracle.Parse("{ this is not json"));
    }

    /// <summary>
    /// The TRX parser extracts only the <c>UnitTestResult</c> rows (ignoring the
    /// <c>ResultSummary</c> banner whose outcome is <c>Completed</c>), reads the
    /// <c>testName</c>/<c>outcome</c> attributes, and sorts by name — matching the
    /// shape <c>corpus/trx-to-baseline.py</c> records.
    /// </summary>
    [Fact]
    public void TrxParser_ParsesUnitTestResults_SkipsSummary()
    {
        IReadOnlyList<TestCaseOutcome> results = TrxParser.ParseFile(Fixture("sample.pass.trx"));

        Assert.Equal(4, results.Count);
        Assert.DoesNotContain(results, r => r.Outcome == "Completed");
        Assert.All(results, r => Assert.Equal("Passed", r.Outcome));

        // Sorted by name ordinal.
        var names = results.Select(r => r.Name).ToArray();
        var sorted = names.OrderBy(n => n, StringComparer.Ordinal).ToArray();
        Assert.Equal(sorted, names);
    }

    /// <summary>
    /// Exact-match parity: the G# TRX equals the baseline, so the comparison
    /// yields zero differences and <see cref="TestParityResult.IsMatch"/> is true.
    /// Theory inline-data case names compare verbatim, so the two
    /// <c>Add_Cases(...)</c> cases each match.
    /// </summary>
    [Fact]
    public void Compare_ExactMatch_IsParity()
    {
        BaselineTestsOracle oracle = BaselineTestsOracle.Load(Fixture("baseline.sample.json"));
        IReadOnlyList<TestCaseOutcome> actual = TrxParser.ParseFile(Fixture("sample.pass.trx"));

        TestParityResult result = TestParityComparison.Compare(oracle.Tests, actual);

        Assert.True(result.IsMatch);
        Assert.Empty(result.Differences);
    }

    /// <summary>
    /// A failed G# test (outcome differs from the baseline <c>Passed</c>) yields a
    /// single <see cref="TestDiffKind.OutcomeMismatch"/> diff naming the test.
    /// </summary>
    [Fact]
    public void Compare_FailedTest_YieldsOutcomeMismatch()
    {
        BaselineTestsOracle oracle = BaselineTestsOracle.Load(Fixture("baseline.sample.json"));
        IReadOnlyList<TestCaseOutcome> actual = TrxParser.ParseFile(Fixture("sample.failed.trx"));

        TestParityResult result = TestParityComparison.Compare(oracle.Tests, actual);

        TestParityDiff diff = Assert.Single(result.Differences);
        Assert.Equal(TestDiffKind.OutcomeMismatch, diff.Kind);
        Assert.Equal("Sample.Tests.CalculatorTests.Subtract_Returns_Difference", diff.Name);
        Assert.Equal("Passed", diff.ExpectedOutcome);
        Assert.Equal("Failed", diff.ActualOutcome);
    }

    /// <summary>
    /// A baseline test the G# run did not produce yields a
    /// <see cref="TestDiffKind.Missing"/> diff with a null actual outcome.
    /// </summary>
    [Fact]
    public void Compare_MissingTest_YieldsMissing()
    {
        var expected = new[]
        {
            new TestCaseOutcome("N.C.A", "Passed"),
            new TestCaseOutcome("N.C.B", "Passed"),
        };
        var actual = new[] { new TestCaseOutcome("N.C.A", "Passed") };

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        TestParityDiff diff = Assert.Single(result.Differences);
        Assert.Equal(TestDiffKind.Missing, diff.Kind);
        Assert.Equal("N.C.B", diff.Name);
        Assert.Null(diff.ActualOutcome);
    }

    /// <summary>
    /// A G# test not present in the baseline yields a
    /// <see cref="TestDiffKind.Extra"/> diff with a null expected outcome.
    /// </summary>
    [Fact]
    public void Compare_ExtraTest_YieldsExtra()
    {
        var expected = new[] { new TestCaseOutcome("N.C.A", "Passed") };
        var actual = new[]
        {
            new TestCaseOutcome("N.C.A", "Passed"),
            new TestCaseOutcome("N.C.Z", "Passed"),
        };

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        TestParityDiff diff = Assert.Single(result.Differences);
        Assert.Equal(TestDiffKind.Extra, diff.Kind);
        Assert.Equal("N.C.Z", diff.Name);
        Assert.Null(diff.ExpectedOutcome);
    }

    /// <summary>
    /// A theory inline-data case whose name matches exactly (including the
    /// <c>(arg: val, ...)</c> suffix) is parity; changing one case's args makes it
    /// a missing+extra pair, proving case-name granularity.
    /// </summary>
    [Fact]
    public void Compare_TheoryCaseName_ComparesVerbatim()
    {
        var expected = new[]
        {
            new TestCaseOutcome("N.C.T(a: 1, expected: 2)", "Passed"),
            new TestCaseOutcome("N.C.T(a: 2, expected: 4)", "Passed"),
        };
        var matching = new[]
        {
            new TestCaseOutcome("N.C.T(a: 1, expected: 2)", "Passed"),
            new TestCaseOutcome("N.C.T(a: 2, expected: 4)", "Passed"),
        };
        var shifted = new[]
        {
            new TestCaseOutcome("N.C.T(a: 1, expected: 2)", "Passed"),
            new TestCaseOutcome("N.C.T(a: 3, expected: 6)", "Passed"),
        };

        Assert.True(TestParityComparison.Compare(expected, matching).IsMatch);

        TestParityResult drift = TestParityComparison.Compare(expected, shifted);
        Assert.False(drift.IsMatch);
        Assert.Contains(drift.Differences, d => d.Kind == TestDiffKind.Missing && d.Name.Contains("a: 2"));
        Assert.Contains(drift.Differences, d => d.Kind == TestDiffKind.Extra && d.Name.Contains("a: 3"));
    }

    /// <summary>
    /// An <c>OutcomeMismatch</c> diff produces a <c>test-parity-failure</c>
    /// artifact carrying the stage/category, a <c>TESTPARITY-OutcomeMismatch</c>
    /// diagnostic id, the failing test name as the construct kind, labels
    /// <c>Oats</c> + <c>bug</c>, and a stable <c>sha256:</c> fingerprint.
    /// </summary>
    [Fact]
    public void TestFailureArtifact_HasShapeLabelsAndFingerprint()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample.Tests");
        var diff = new TestParityDiff(
            TestDiffKind.OutcomeMismatch,
            "Sample.Tests.CalculatorTests.Subtract_Returns_Difference",
            "Passed",
            "Failed");

        TriageArtifact artifact = builder.TestParityTestFailure(diff, "corpus_Sample.Tests/CalculatorTests.gs");
        string json = JsonSerializer.Serialize(artifact, TriageSerialization.Options);
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;

        Assert.Equal("test-parity", root.GetProperty("stage").GetString());
        Assert.Equal("test-parity-failure", root.GetProperty("category").GetString());
        Assert.Equal("TESTPARITY-OutcomeMismatch", root.GetProperty("diagnostic").GetProperty("id").GetString());
        Assert.Equal(
            "Sample.Tests.CalculatorTests.Subtract_Returns_Difference",
            root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString());

        string[] labels = root.GetProperty("suggestedIssue").GetProperty("labels")
            .EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Contains("Oats", labels);
        Assert.Contains("bug", labels);

        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// The per-test fingerprint splits on the test name and the diff kind, so the
    /// pipeline emits one artifact per differing test.
    /// </summary>
    [Fact]
    public void TestFailureArtifact_Fingerprint_SplitsPerTest()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample.Tests");

        TriageArtifact a = builder.TestParityTestFailure(
            new TestParityDiff(TestDiffKind.OutcomeMismatch, "N.C.A", "Passed", "Failed"));
        TriageArtifact sameAgain = builder.TestParityTestFailure(
            new TestParityDiff(TestDiffKind.OutcomeMismatch, "N.C.A", "Passed", "Failed"));
        TriageArtifact differentTest = builder.TestParityTestFailure(
            new TestParityDiff(TestDiffKind.OutcomeMismatch, "N.C.B", "Passed", "Failed"));
        TriageArtifact differentKind = builder.TestParityTestFailure(
            new TestParityDiff(TestDiffKind.Missing, "N.C.A", "Passed", null));

        Assert.Equal(a.Fingerprint, sameAgain.Fingerprint);
        Assert.NotEqual(a.Fingerprint, differentTest.Fingerprint);
        Assert.NotEqual(a.Fingerprint, differentKind.Fingerprint);
    }

    /// <summary>
    /// Stdout parity normalizes CRLF→LF and a single trailing newline (the L1
    /// recipe), so a golden and an actual that differ only in line endings and
    /// trailing whitespace still match.
    /// </summary>
    [Fact]
    public void StdoutParity_Normalizes_LineEndingsAndTrailingNewline()
    {
        StdoutParityResult result = StdoutParity.Compare("line1\nline2\n", "line1\r\nline2\r\n\n\n");

        Assert.True(result.IsMatch);
    }

    /// <summary>
    /// A stdout mismatch isolates the first differing line (1-based) and both
    /// sides, and yields a <c>test-parity-failure</c> artifact with the
    /// <c>STDOUT-MISMATCH</c> id, <c>ProgramStdout</c> construct kind, labels
    /// <c>Oats</c> + <c>bug</c>, and a stable fingerprint.
    /// </summary>
    [Fact]
    public void StdoutParity_Mismatch_ProducesArtifact()
    {
        StdoutParityResult result = StdoutParity.Compare("hello\nworld\n", "hello\nthere\n");

        Assert.False(result.IsMatch);
        Assert.Equal(2, result.LineNumber);
        Assert.Equal("world", result.ExpectedLine);
        Assert.Equal("there", result.ActualLine);

        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/L1-Console");
        TriageArtifact artifact = builder.TestParityStdoutFailure(result, "corpus_L1-Console/Program.gs");
        string json = JsonSerializer.Serialize(artifact, TriageSerialization.Options);
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;

        Assert.Equal("test-parity", root.GetProperty("stage").GetString());
        Assert.Equal("test-parity-failure", root.GetProperty("category").GetString());
        Assert.Equal("STDOUT-MISMATCH", root.GetProperty("diagnostic").GetProperty("id").GetString());
        Assert.Equal(
            "ProgramStdout",
            root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString());

        string[] labels = root.GetProperty("suggestedIssue").GetProperty("labels")
            .EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Contains("Oats", labels);
        Assert.Contains("bug", labels);

        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal);
    }

    private static string Fixture(string fileName)
    {
        return Path.Combine(AppContext.BaseDirectory, "Fixtures", "TestParity", fileName);
    }
}
