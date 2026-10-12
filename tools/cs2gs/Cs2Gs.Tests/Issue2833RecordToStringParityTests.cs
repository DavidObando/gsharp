// <copyright file="Issue2833RecordToStringParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2833, retired by ADR-0199: xUnit builds a theory case's display name
/// from each argument's <c>ToString()</c>. A G# <c>data</c> type now renders
/// exactly like a C# <c>record</c> (<c>Rectangle { Width = 3, Height = 4 }</c>),
/// so the display names on both sides of the parity comparison are identical
/// verbatim and the Kotlin-to-C# name normalizer is gone. These tests pin
/// that: matching record names match, and the old Kotlin spelling is no
/// longer papered over.
/// </summary>
public class Issue2833RecordToStringParityTests
{
    [Fact]
    public void Compare_MatchesRecordRenderingVerbatim()
    {
        var expected = Outcomes(
            ("T.Shapes(shape: Rectangle { Width = 3, Height = 4 }, expected: 12)", "Passed"),
            ("T.Shapes(shape: Marker { }, expected: 0)", "Passed"));
        var actual = Outcomes(
            ("T.Shapes(shape: Rectangle { Width = 3, Height = 4 }, expected: 12)", "Passed"),
            ("T.Shapes(shape: Marker { }, expected: 0)", "Passed"));

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        Assert.True(result.IsMatch, string.Join("; ", result.Differences.Select(d => d.Describe())));
    }

    [Fact]
    public void Compare_NoLongerNormalizesTheKotlinSpelling()
    {
        var expected = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Passed"));
        var actual = Outcomes(("T.Shapes(shape: Circle(Radius=2))", "Passed"));

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        Assert.Equal(2, result.Differences.Count);
        Assert.Contains(result.Differences, d => d.Kind == TestDiffKind.Missing && d.Name == "T.Shapes(shape: Circle { Radius = 2 })");
        Assert.Contains(result.Differences, d => d.Kind == TestDiffKind.Extra && d.Name == "T.Shapes(shape: Circle(Radius=2))");
    }

    [Fact]
    public void Compare_StillReportsOutcomeMismatchForARecordCase()
    {
        var expected = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Passed"));
        var actual = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Failed"));

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        TestParityDiff diff = Assert.Single(result.Differences);
        Assert.Equal(TestDiffKind.OutcomeMismatch, diff.Kind);
        Assert.Equal("Passed", diff.ExpectedOutcome);
        Assert.Equal("Failed", diff.ActualOutcome);
    }

    private static IReadOnlyList<TestCaseOutcome> Outcomes(params (string Name, string Outcome)[] entries) =>
        entries.Select(e => new TestCaseOutcome(e.Name, e.Outcome)).ToList();
}
