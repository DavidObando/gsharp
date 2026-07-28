// <copyright file="Issue2833RecordToStringParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2833: xUnit builds a theory case's display name from each argument's
/// <c>ToString()</c>, and ADR-0029 deliberately picked the Kotlin rendering
/// (<c>Rectangle(Width=3, Height=4)</c>) for G# <c>data</c> types over the C#
/// record rendering (<c>Rectangle { Width = 3, Height = 4 }</c>). Matching on
/// the raw display name therefore reported a spurious
/// <c>TESTPARITY-Missing</c> + <c>TESTPARITY-Extra</c> pair for every such
/// case even though the test ran and passed identically on both sides.
/// </summary>
public class Issue2833RecordToStringParityTests
{
    [Theory]

    // The exact repro from corpus/L3-Library.
    [InlineData(
        "T.Shapes(shape: Rectangle { Width = 3, Height = 4 }, expected: 12)",
        "T.Shapes(shape: Rectangle(Width=3, Height=4), expected: 12)")]

    // Single-field record.
    [InlineData("T.Shapes(shape: Circle { Radius = 2 })", "T.Shapes(shape: Circle(Radius=2))")]

    // Zero-field record: ADR-0029 renders `Marker()`.
    [InlineData("T.Shapes(shape: Marker { })", "T.Shapes(shape: Marker())")]

    // Nested records fold innermost-first.
    [InlineData(
        "T.Nest(v: Outer { Inner = Inner { X = 1 }, Tag = a })",
        "T.Nest(v: Outer(Inner=Inner(X=1), Tag=a))")]

    // Generic record type names survive the rewrite.
    [InlineData("T.G(v: Wrapper`1[System.Int32] { Value = 1 })", "T.G(v: Wrapper`1[System.Int32](Value=1))")]
    public void NormalizeTestName_CanonicalizesRecordToString(string cSharpName, string expected)
    {
        Assert.Equal(expected, TestParityComparison.NormalizeTestName(cSharpName));
    }

    [Theory]
    [InlineData("T.Shapes(shape: Rectangle(Width=3, Height=4))")]
    [InlineData("Ns.Class.Method")]
    [InlineData("Ns.Class.Method(arg: 1, expected: 2)")]
    [InlineData(null)]
    [InlineData("")]
    public void NormalizeTestName_IsIdempotentOnAlreadyNormalizedNames(string name)
    {
        var once = TestParityComparison.NormalizeTestName(name);
        Assert.Equal(name, once);
        Assert.Equal(once, TestParityComparison.NormalizeTestName(once));
    }

    [Fact]
    public void Compare_TreatsRecordToStringSpellingsAsTheSameTest()
    {
        var expected = Outcomes(
            ("T.Shapes(shape: Rectangle { Width = 3, Height = 4 }, expected: 12)", "Passed"),
            ("T.Shapes(shape: Circle { Radius = 2 }, expected: 12.5)", "Passed"));
        var actual = Outcomes(
            ("T.Shapes(shape: Rectangle(Width=3, Height=4), expected: 12)", "Passed"),
            ("T.Shapes(shape: Circle(Radius=2), expected: 12.5)", "Passed"));

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        Assert.True(result.IsMatch, string.Join("; ", result.Differences.Select(d => d.Describe())));
    }

    [Fact]
    public void Compare_StillReportsOutcomeMismatchAcrossSpellings()
    {
        var expected = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Passed"));
        var actual = Outcomes(("T.Shapes(shape: Circle(Radius=2))", "Failed"));

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        TestParityDiff diff = Assert.Single(result.Differences);
        Assert.Equal(TestDiffKind.OutcomeMismatch, diff.Kind);

        // The diagnostic quotes the original C# baseline display name.
        Assert.Equal("T.Shapes(shape: Circle { Radius = 2 })", diff.Name);
        Assert.Equal("Passed", diff.ExpectedOutcome);
        Assert.Equal("Failed", diff.ActualOutcome);
    }

    [Fact]
    public void Compare_StillReportsGenuineMissingAndExtra()
    {
        var expected = Outcomes(
            ("T.Shapes(shape: Circle { Radius = 2 })", "Passed"),
            ("T.Gone", "Passed"));
        var actual = Outcomes(
            ("T.Shapes(shape: Circle(Radius=2))", "Passed"),
            ("T.New", "Passed"));

        TestParityResult result = TestParityComparison.Compare(expected, actual);

        Assert.Equal(2, result.Differences.Count);
        Assert.Contains(result.Differences, d => d.Kind == TestDiffKind.Missing && d.Name == "T.Gone");
        Assert.Contains(result.Differences, d => d.Kind == TestDiffKind.Extra && d.Name == "T.New");
    }

    private static IReadOnlyList<TestCaseOutcome> Outcomes(params (string Name, string Outcome)[] entries) =>
        entries.Select(e => new TestCaseOutcome(e.Name, e.Outcome)).ToList();
}
