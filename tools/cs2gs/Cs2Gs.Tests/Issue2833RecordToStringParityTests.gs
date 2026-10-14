// <copyright file="Issue2833RecordToStringParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2833, retired by ADR-0199: xUnit builds a theory case's display name
/// from each argument's `ToString()`. A G# `data` type now renders
/// exactly like a C# `record` (`Rectangle { Width = 3, Height = 4 }`),
/// so the display names on both sides of the parity comparison are identical
/// verbatim and the Kotlin-to-C# name normalizer is gone. These tests pin
/// that: matching record names match, and the old Kotlin spelling is no
/// longer papered over.
open class Issue2833RecordToStringParityTests {
    @Fact
    func Compare_MatchesRecordRenderingVerbatim() {
        let expected = Outcomes(
            ("T.Shapes(shape: Rectangle { Width = 3, Height = 4 }, expected: 12)", "Passed"),
            ("T.Shapes(shape: Marker { }, expected: 0)", "Passed")
        )
        let actual = Outcomes(
            ("T.Shapes(shape: Rectangle { Width = 3, Height = 4 }, expected: 12)", "Passed"),
            ("T.Shapes(shape: Marker { }, expected: 0)", "Passed")
        )
        let result = TestParityComparison.Compare(expected, actual)
        Assert.True(result.IsMatch, string.Join("; ", result.Differences.Select((d TestParityDiff) -> d.Describe())))
    }

    @Fact
    func Compare_NoLongerNormalizesTheKotlinSpelling() {
        let expected = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Passed"))
        let actual = Outcomes(("T.Shapes(shape: Circle(Radius=2))", "Passed"))
        let result = TestParityComparison.Compare(expected, actual)
        Assert.Equal(2, result.Differences.Count)
        Assert.Contains(
            result.Differences,
            (d TestParityDiff) -> d.Kind == TestDiffKind.Missing && d.Name == "T.Shapes(shape: Circle { Radius = 2 })"
        )
        Assert.Contains(
            result.Differences,
            (d TestParityDiff) -> d.Kind == TestDiffKind.Extra && d.Name == "T.Shapes(shape: Circle(Radius=2))"
        )
    }

    @Fact
    func Compare_StillReportsOutcomeMismatchForARecordCase() {
        let expected = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Passed"))
        let actual = Outcomes(("T.Shapes(shape: Circle { Radius = 2 })", "Failed"))
        let result = TestParityComparison.Compare(expected, actual)
        let diff = Assert.Single(result.Differences)
        Assert.Equal(TestDiffKind.OutcomeMismatch, diff.Kind)
        Assert.Equal("Passed", diff.ExpectedOutcome)
        Assert.Equal("Failed", diff.ActualOutcome)
    }

    shared {
        private func Outcomes(entries ...(Name string, Outcome string)) IReadOnlyList[TestCaseOutcome] -> entries
            .Select((e(Name string, Outcome string)) -> TestCaseOutcome(e.Name, e.Outcome)).ToList()
    }
}
