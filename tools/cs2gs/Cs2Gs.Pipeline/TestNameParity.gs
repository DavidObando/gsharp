// <copyright file="TestNameParity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Linq

/// Issue #4633: compares the C# original's discovered test-case names
/// ((cref:CSharpTestOracle)) with the test cases the migrated run
/// actually executed (its TRX), name for name.
///
/// Names are compared as MULTISETS: two theory rows whose
/// arguments render identically are two cases on both sides, so one of them
/// vanishing is still a missing case.
///
/// One asymmetry is inherent to comparing discovery with execution. xUnit
/// pre-enumerates a `[Theory]` into one case per row only when every row's
/// data is serializable; otherwise discovery reports ONE case, the bare method
/// name, and execution reports a result per row (`M(x: ...)`). A bare C#
/// name with no exact migrated match is therefore satisfied by one or more
/// migrated rows of that method. Row COUNTS of such theories cannot be checked
/// against discovery (the C# side never enumerated them); every other case,
/// every pre-enumerated row included, is checked exactly.
shared class TestNameParity {
    private class NameTally {
        init(key string?, display string) {
            this.Key = key
            this.Display = display
        }

        prop Key string? {
            get;
        }

        prop Display string {
            get;
        }

        prop Remaining int32
    }

    /// Compares the expected (C#) names with the actual (migrated) results.
    /// @param expected The C# original's discovered display names.
    /// @param actual The migrated run's per-case results.
    /// @returns The comparison result.
    func Compare(expected IReadOnlyList[string]?, actual IReadOnlyList[TestCaseOutcome]?) TestNameParityResult {
        if expected == nil {
            throw ArgumentNullException("expected")
        }
        if actual == nil {
            throw ArgumentNullException("actual")
        }
        let expectedTally = Tally(expected)
        let actualNames = actual
            .Where((result TestCaseOutcome) -> result?.Name != nil)
            .Select((result TestCaseOutcome) -> result.Name!!)
            .ToList()
        let actualTally = Tally(actualNames)
        var matched = 0
        for pair in expectedTally {
            if actualTally.TryGetValue(pair.Key, out var other) {
                let common = Math.Min(pair.Value.Remaining, other.Remaining)
                pair.Value.Remaining -= common
                other.Remaining -= common
                matched += common
            }
        }
        // A bare C# name (no argument list) that is still unmatched may be a
        // theory xUnit did not pre-enumerate: its rows run as `Name(...)`.
        let unmatchedRowsByMethod = actualTally
            .Values
            .Where((tally NameTally) -> tally.Remaining > 0 && tally.Key!!.IndexOf('(') > 0)
            .GroupBy((tally NameTally) -> MethodPart(tally.Key)!!, StringComparer.Ordinal)
            .ToDictionary(
            func (group IGrouping[string, NameTally]) string {
                return group.Key
            },
            (group IGrouping[string, NameTally]) -> group.ToList(),
            StringComparer.Ordinal
        )
        var theoryRows = 0
        for bare in expectedTally.Values.Where(
            (tally NameTally) -> tally.Remaining > 0 && tally.Key!!.IndexOf('(') < 0
        ) {
            if !unmatchedRowsByMethod.TryGetValue(bare.Key!!, out var rows) {
                continue
            }
            // Each outstanding bare occurrence needs at least one row of its
            // own (a multi-targeted listing repeats the bare name). Every row
            // of the method is consumed and counted in theoryRows, the number
            // of executed rows attributed to non-enumerated theories.
            let available = rows.Sum((row NameTally) -> row.Remaining)
            let satisfied = Math.Min(bare.Remaining, available)
            for row in rows {
                theoryRows += row.Remaining
                row.Remaining = 0
            }
            unmatchedRowsByMethod.Remove(bare.Key!!)
            matched += satisfied
            bare.Remaining -= satisfied
        }
        return TestNameParityResult(
            expected.Count,
            actualNames.Count,
            matched,
            theoryRows,
            Unmatched(expectedTally),
            Unmatched(actualTally)
        )
    }

    /// The method part of a display name: everything before the argument list.
    /// @param name A test-case display name.
    /// @returns The name up to (not including) its first `(`.
    func MethodPart(name string?) string? {
        if string.IsNullOrEmpty(name) {
            return name
        }
        let open_ = name.IndexOf('(')
        return if open_ < 0 {
            name
        } else {
            name.Substring(0, open_)
        }
    }

    private func Tally(names IEnumerable[string]) Dictionary[string, NameTally] {
        let tally = Dictionary[string, NameTally](StringComparer.Ordinal)
        for name in names {
            if name == nil {
                continue
            }
            let key string? = name
            if !tally.TryGetValue(key!!, out var entry) {
                entry = NameTally(key, name)
                tally.Add(key!!, entry)
            }
            entry.Remaining++
        }
        return tally
    }

    private func Unmatched(tally Dictionary[string, NameTally]) IReadOnlyList[string] {
        let names = List[string]()
        for entry in tally.Values {
            for var index = 0; index < entry.Remaining; index++ {
                names.Add(entry.Display)
            }
        }
        names.Sort(StringComparer.Ordinal)
        return names
    }
}

/// Issue #4633: the outcome of (cref:TestNameParity.Compare).
class TestNameParityResult {
    /// Initializes a new instance of the (cref:TestNameParityResult) class.
    /// @param expectedCount The number of C# oracle names.
    /// @param actualCount The number of migrated results.
    /// @param matched The number of C# names matched by a migrated result.
    /// @param theoryRows The migrated rows matched to a bare (non-enumerated) C# theory.
    /// @param missing The C# names with no migrated result, sorted.
    /// @param extra The migrated results with no C# name, sorted.
    init(
        expectedCount int32,
        actualCount int32,
        matched int32,
        theoryRows int32,
        missing IReadOnlyList[string],
        extra IReadOnlyList[string]
    ) {
        this.ExpectedCount = expectedCount
        this.ActualCount = actualCount
        this.Matched = matched
        this.TheoryRows = theoryRows
        this.Missing = missing ?? Array.Empty[string]()
        this.Extra = extra ?? Array.Empty[string]()
    }

    /// Gets the number of C# oracle names.
    prop ExpectedCount int32 {
        get;
    }

    /// Gets the number of migrated results.
    prop ActualCount int32 {
        get;
    }

    /// Gets the number of C# names matched by a migrated result.
    prop Matched int32 {
        get;
    }

    /// Gets the migrated rows that matched a bare (non-enumerated) C# theory.
    prop TheoryRows int32 {
        get;
    }

    /// Gets the C# names the migrated run did not execute, sorted.
    prop Missing IReadOnlyList[string] {
        get;
    }

    /// Gets the migrated results that are not in the C# oracle, sorted.
    prop Extra IReadOnlyList[string] {
        get;
    }

    /// Gets a value indicating whether every name matched in both directions.
    prop IsMatch bool -> this.Missing.Count == 0 && this.Extra.Count == 0
}
