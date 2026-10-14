// <copyright file="TestParityComparison.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Linq

/// The kind of a single test-parity difference (ADR-0115 §C).
enum TestDiffKind {
    Missing,
    Extra,
    OutcomeMismatch
}

/// The xUnit pass/fail-set comparison engine for stage 4 (ADR-0115 §C/§E):
/// compares the G# `dotnet test` outcomes against the committed C# baseline
/// oracle and yields the precise per-test differences. Any test that is
/// <i>missing</i> (in the baseline but not the G# run), <i>extra</i> (in the G#
/// run but not the baseline), or whose <i>outcome differs</i> breaks parity.
/// xUnit theory case names (`Method(arg: 1, expected: 2)`) participate
/// verbatim, so a single theory case mismatch is isolated.
shared class TestParityComparison {
    /// Compares an expected baseline outcome set with the actual G# run outcomes.
    /// @param expected The C# baseline oracle test outcomes.
    /// @param actual The actual G# `dotnet test` outcomes.
    /// @returns The comparison result with the ordered list of differences.
    func Compare(expected IReadOnlyList[TestCaseOutcome]?, actual IReadOnlyList[TestCaseOutcome]?) TestParityResult {
        if expected == nil {
            throw ArgumentNullException("expected")
        }
        if actual == nil {
            throw ArgumentNullException("actual")
        }
        let expectedByName = Dictionary[string, (Display string?, Outcome string?)](StringComparer.Ordinal)
        for test in expected {
            if test?.Name != nil {
                expectedByName[test.Name!!] = (test.Name, test.Outcome)
            }
        }
        let actualByName = Dictionary[string, (Display string?, Outcome string?)](StringComparer.Ordinal)
        for test in actual {
            if test?.Name != nil {
                actualByName[test.Name!!] = (test.Name, test.Outcome)
            }
        }
        let diffs = List[TestParityDiff]()
        for pair in expectedByName.OrderBy(
            (p KeyValuePair[string, (Display string, Outcome string)]) -> p.Key,
            StringComparer.Ordinal
        ) {
            if !actualByName.TryGetValue(pair.Key, out var actualEntry) {
                diffs.Add(TestParityDiff(TestDiffKind.Missing, pair.Value.Display!!, pair.Value.Outcome, nil))
            } else if !string.Equals(pair.Value.Outcome, actualEntry.Outcome, StringComparison.Ordinal) {
                diffs.Add(
                    TestParityDiff(
                        TestDiffKind.OutcomeMismatch,
                        pair.Value.Display!!,
                        pair.Value.Outcome,
                        actualEntry.Outcome
                    )
                )
            }
        }
        for pair in actualByName.OrderBy(
            (p KeyValuePair[string, (Display string, Outcome string)]) -> p.Key,
            StringComparer.Ordinal
        ) {
            if !expectedByName.ContainsKey(pair.Key) {
                diffs.Add(TestParityDiff(TestDiffKind.Extra, pair.Value.Display!!, nil, pair.Value.Outcome))
            }
        }
        return TestParityResult(diffs)
    }
}

/// One test-parity difference: the test name plus the expected and actual
/// outcomes (ADR-0115 §C). For a (cref:TestDiffKind.Missing) diff the
/// actual outcome is `null`; for (cref:TestDiffKind.Extra)
/// the expected outcome is `null`.
class TestParityDiff {
    /// Initializes a new instance of the (cref:TestParityDiff) class.
    /// @param kind The difference kind.
    /// @param name The fully qualified test name.
    /// @param expectedOutcome The baseline outcome, or null when extra.
    /// @param actualOutcome The actual outcome, or null when missing.
    init(kind TestDiffKind, name string, expectedOutcome string?, actualOutcome string?) {
        this.Kind = kind
        this.Name = name
        this.ExpectedOutcome = expectedOutcome
        this.ActualOutcome = actualOutcome
    }

    /// Gets the difference kind.
    prop Kind TestDiffKind {
        get;
    }

    /// Gets the fully qualified test name.
    prop Name string {
        get;
    }

    /// Gets the baseline outcome (null when this test is extra).
    prop ExpectedOutcome string? {
        get;
    }

    /// Gets the actual outcome (null when this test is missing).
    prop ActualOutcome string? {
        get;
    }

    /// Gets a one-line expected-vs-actual description used in the triage
    /// diagnostic message.
    /// @returns The one-line description.
    func Describe() string -> switch this.Kind {
        case TestDiffKind.Missing: "test '${this.Name}' is in the C# baseline (outcome ${this.ExpectedOutcome}) but the G# run did not produce it"
        case TestDiffKind.Extra: "test '${this.Name}' (outcome ${this.ActualOutcome}) was produced by the G# run but is not in the C# baseline"
        case TestDiffKind.OutcomeMismatch: "test '${this.Name}': expected ${this.ExpectedOutcome} but the G# run reported ${this.ActualOutcome}"
        default: this.Name
    }
}

/// The result of an xUnit pass/fail-set comparison (ADR-0115 §C).
class TestParityResult {
    /// Initializes a new instance of the (cref:TestParityResult) class.
    /// @param differences The ordered per-test differences (empty on parity).
    init(differences IReadOnlyList[TestParityDiff]) {
        this.Differences = differences ?? Array.Empty[TestParityDiff]()
    }

    /// Gets the ordered per-test differences (empty when parity holds).
    prop Differences IReadOnlyList[TestParityDiff] {
        get;
    }

    /// Gets a value indicating whether the G# run matched the C# baseline.
    prop IsMatch bool -> this.Differences.Count == 0
}
