// <copyright file="TestParityComparison.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;

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

        var expectedByName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TestCaseOutcome test in expected)
        {
            if (test?.Name is not null)
            {
                expectedByName[test.Name] = test.Outcome;
            }
        }

        var actualByName = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TestCaseOutcome test in actual)
        {
            if (test?.Name is not null)
            {
                actualByName[test.Name] = test.Outcome;
            }
        }

        var diffs = new List<TestParityDiff>();

        foreach (KeyValuePair<string, string> pair in expectedByName.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            if (!actualByName.TryGetValue(pair.Key, out string actualOutcome))
            {
                diffs.Add(new TestParityDiff(TestDiffKind.Missing, pair.Key, pair.Value, null));
            }
            else if (!string.Equals(pair.Value, actualOutcome, StringComparison.Ordinal))
            {
                diffs.Add(new TestParityDiff(TestDiffKind.OutcomeMismatch, pair.Key, pair.Value, actualOutcome));
            }
        }

        foreach (KeyValuePair<string, string> pair in actualByName.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            if (!expectedByName.ContainsKey(pair.Key))
            {
                diffs.Add(new TestParityDiff(TestDiffKind.Extra, pair.Key, null, pair.Value));
            }
        }

        return new TestParityResult(diffs);
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
