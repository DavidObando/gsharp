// <copyright file="TestParityComparison.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The kind of a single test-parity difference (ADR-0115 §C).
/// </summary>
public enum TestDiffKind
{
    /// <summary>A baseline test the G# run did not produce.</summary>
    Missing,

    /// <summary>A G# test not present in the baseline.</summary>
    Extra,

    /// <summary>A test present in both whose outcome differs.</summary>
    OutcomeMismatch,
}

/// <summary>
/// The xUnit pass/fail-set comparison engine for stage 4 (ADR-0115 §C/§E):
/// compares the G# <c>dotnet test</c> outcomes against the committed C# baseline
/// oracle and yields the precise per-test differences. Any test that is
/// <i>missing</i> (in the baseline but not the G# run), <i>extra</i> (in the G#
/// run but not the baseline), or whose <i>outcome differs</i> breaks parity.
/// xUnit theory case names (<c>Method(arg: 1, expected: 2)</c>) participate
/// verbatim, so a single theory case mismatch is isolated.
/// </summary>
public static class TestParityComparison
{
    /// <summary>
    /// Matches one innermost C#-record <c>ToString()</c> rendering embedded in an
    /// xUnit theory display name: <c>Rectangle { Width = 3, Height = 4 }</c>.
    /// The <c>[^{}]*</c> body keeps the match innermost so nested records
    /// normalize from the inside out (issue #2833).
    /// </summary>
    private static readonly Regex CSharpRecordToStringPattern = new(
        @"(?<name>[\w`.+<>,\[\]]+) \{(?<body>[^{}]*)\}",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Matches the <c> = </c> separator inside a normalized record body.
    /// </summary>
    private static readonly Regex RecordFieldSeparatorPattern = new(
        @" = ",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Compares an expected baseline outcome set with the actual G# run outcomes.
    /// </summary>
    /// <param name="expected">The C# baseline oracle test outcomes.</param>
    /// <param name="actual">The actual G# <c>dotnet test</c> outcomes.</param>
    /// <returns>The comparison result with the ordered list of differences.</returns>
    public static TestParityResult Compare(
        IReadOnlyList<TestCaseOutcome> expected,
        IReadOnlyList<TestCaseOutcome> actual)
    {
        if (expected is null)
        {
            throw new ArgumentNullException(nameof(expected));
        }

        if (actual is null)
        {
            throw new ArgumentNullException(nameof(actual));
        }

        var expectedByName = new Dictionary<string, (string Display, string Outcome)>(StringComparer.Ordinal);
        foreach (TestCaseOutcome test in expected)
        {
            if (test?.Name is not null)
            {
                expectedByName[NormalizeTestName(test.Name)] = (test.Name, test.Outcome);
            }
        }

        var actualByName = new Dictionary<string, (string Display, string Outcome)>(StringComparer.Ordinal);
        foreach (TestCaseOutcome test in actual)
        {
            if (test?.Name is not null)
            {
                actualByName[NormalizeTestName(test.Name)] = (test.Name, test.Outcome);
            }
        }

        var diffs = new List<TestParityDiff>();

        foreach (KeyValuePair<string, (string Display, string Outcome)> pair in
            expectedByName.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            if (!actualByName.TryGetValue(pair.Key, out (string Display, string Outcome) actualEntry))
            {
                diffs.Add(new TestParityDiff(TestDiffKind.Missing, pair.Value.Display, pair.Value.Outcome, null));
            }
            else if (!string.Equals(pair.Value.Outcome, actualEntry.Outcome, StringComparison.Ordinal))
            {
                diffs.Add(new TestParityDiff(
                    TestDiffKind.OutcomeMismatch, pair.Value.Display, pair.Value.Outcome, actualEntry.Outcome));
            }
        }

        foreach (KeyValuePair<string, (string Display, string Outcome)> pair in
            actualByName.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            if (!expectedByName.ContainsKey(pair.Key))
            {
                diffs.Add(new TestParityDiff(TestDiffKind.Extra, pair.Value.Display, null, pair.Value.Outcome));
            }
        }

        return new TestParityResult(diffs);
    }

    /// <summary>
    /// Canonicalizes a test display name so the ADR-0029 <c>data</c>-type
    /// <c>ToString()</c> format is comparable with the C# <c>record</c> format
    /// (issue #2833).
    /// </summary>
    /// <remarks>
    /// <para>
    /// xUnit builds a theory case's display name from each argument's
    /// <c>ToString()</c>. ADR-0029 deliberately picked the Kotlin rendering
    /// <c>Rectangle(Width=3, Height=4)</c> over the C# record rendering
    /// <c>Rectangle { Width = 3, Height = 4 }</c>, so a theory whose data
    /// includes a record produces display names that differ between the C#
    /// baseline oracle and the migrated G# run even though every test ran and
    /// passed identically. Matching those cases on the raw display name reports
    /// a spurious <c>Missing</c> + <c>Extra</c> pair per case.
    /// </para>
    /// <para>
    /// The normalization rewrites the C# spelling into the G# spelling before
    /// comparison, innermost-first so nested records fold correctly. It is
    /// idempotent: a name already in the G# spelling contains no braces and is
    /// returned unchanged. Diagnostics still report the original display name.
    /// </para>
    /// </remarks>
    /// <param name="name">The raw xUnit test display name.</param>
    /// <returns>The canonicalized name used as the comparison key.</returns>
    public static string NormalizeTestName(string name)
    {
        if (string.IsNullOrEmpty(name) || name.IndexOf('{') < 0)
        {
            return name;
        }

        string current = name;
        for (int guard = 0; guard < 32; guard++)
        {
            string next = CSharpRecordToStringPattern.Replace(
                current,
                m =>
                {
                    string body = m.Groups["body"].Value.Trim();
                    return body.Length == 0
                        ? m.Groups["name"].Value + "()"
                        : m.Groups["name"].Value + "(" + RecordFieldSeparatorPattern.Replace(body, "=") + ")";
                });

            if (string.Equals(next, current, StringComparison.Ordinal))
            {
                return next;
            }

            current = next;
        }

        return current;
    }
}

/// <summary>
/// One test-parity difference: the test name plus the expected and actual
/// outcomes (ADR-0115 §C). For a <see cref="TestDiffKind.Missing"/> diff the
/// actual outcome is <see langword="null"/>; for <see cref="TestDiffKind.Extra"/>
/// the expected outcome is <see langword="null"/>.
/// </summary>
public sealed class TestParityDiff
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TestParityDiff"/> class.
    /// </summary>
    /// <param name="kind">The difference kind.</param>
    /// <param name="name">The fully qualified test name.</param>
    /// <param name="expectedOutcome">The baseline outcome, or null when extra.</param>
    /// <param name="actualOutcome">The actual outcome, or null when missing.</param>
    public TestParityDiff(TestDiffKind kind, string name, string expectedOutcome, string actualOutcome)
    {
        this.Kind = kind;
        this.Name = name;
        this.ExpectedOutcome = expectedOutcome;
        this.ActualOutcome = actualOutcome;
    }

    /// <summary>Gets the difference kind.</summary>
    public TestDiffKind Kind { get; }

    /// <summary>Gets the fully qualified test name.</summary>
    public string Name { get; }

    /// <summary>Gets the baseline outcome (null when this test is extra).</summary>
    public string ExpectedOutcome { get; }

    /// <summary>Gets the actual outcome (null when this test is missing).</summary>
    public string ActualOutcome { get; }

    /// <summary>
    /// Gets a one-line expected-vs-actual description used in the triage
    /// diagnostic message.
    /// </summary>
    /// <returns>The one-line description.</returns>
    public string Describe() => this.Kind switch
    {
        TestDiffKind.Missing =>
            $"test '{this.Name}' is in the C# baseline (outcome {this.ExpectedOutcome}) but the G# run did not produce it",
        TestDiffKind.Extra =>
            $"test '{this.Name}' (outcome {this.ActualOutcome}) was produced by the G# run but is not in the C# baseline",
        TestDiffKind.OutcomeMismatch =>
            $"test '{this.Name}': expected {this.ExpectedOutcome} but the G# run reported {this.ActualOutcome}",
        _ => this.Name,
    };
}

/// <summary>
/// The result of an xUnit pass/fail-set comparison (ADR-0115 §C).
/// </summary>
public sealed class TestParityResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TestParityResult"/> class.
    /// </summary>
    /// <param name="differences">The ordered per-test differences (empty on parity).</param>
    public TestParityResult(IReadOnlyList<TestParityDiff> differences)
    {
        this.Differences = differences ?? Array.Empty<TestParityDiff>();
    }

    /// <summary>Gets the ordered per-test differences (empty when parity holds).</summary>
    public IReadOnlyList<TestParityDiff> Differences { get; }

    /// <summary>Gets a value indicating whether the G# run matched the C# baseline.</summary>
    public bool IsMatch => this.Differences.Count == 0;
}
