// <copyright file="TestNameParity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #4633: compares the C# original's discovered test-case names
/// (<see cref="CSharpTestOracle"/>) with the test cases the migrated run
/// actually executed (its TRX), name for name.
/// <para>
/// Names are compared as MULTISETS after
/// <see cref="TestParityComparison.NormalizeTestName"/>: two theory rows whose
/// arguments render identically are two cases on both sides, so one of them
/// vanishing is still a missing case.
/// </para>
/// <para>
/// One asymmetry is inherent to comparing discovery with execution. xUnit
/// pre-enumerates a <c>[Theory]</c> into one case per row only when every row's
/// data is serializable; otherwise discovery reports ONE case, the bare method
/// name, and execution reports a result per row (<c>M(x: ...)</c>). A bare C#
/// name with no exact migrated match is therefore satisfied by one or more
/// migrated rows of that method. Row COUNTS of such theories cannot be checked
/// against discovery (the C# side never enumerated them); every other case,
/// every pre-enumerated row included, is checked exactly.
/// </para>
/// </summary>
public static class TestNameParity
{
    /// <summary>
    /// Compares the expected (C#) names with the actual (migrated) results.
    /// </summary>
    /// <param name="expected">The C# original's discovered display names.</param>
    /// <param name="actual">The migrated run's per-case results.</param>
    /// <returns>The comparison result.</returns>
    public static TestNameParityResult Compare(
        IReadOnlyList<string> expected, IReadOnlyList<TestCaseOutcome> actual)
    {
        if (expected is null)
        {
            throw new ArgumentNullException(nameof(expected));
        }

        if (actual is null)
        {
            throw new ArgumentNullException(nameof(actual));
        }

        Dictionary<string, NameTally> expectedTally = Tally(expected);
        List<string> actualNames = actual
            .Where(result => result?.Name is not null)
            .Select(result => result.Name)
            .ToList();
        Dictionary<string, NameTally> actualTally = Tally(actualNames);

        int matched = 0;
        foreach (KeyValuePair<string, NameTally> pair in expectedTally)
        {
            if (actualTally.TryGetValue(pair.Key, out NameTally other))
            {
                int common = Math.Min(pair.Value.Remaining, other.Remaining);
                pair.Value.Remaining -= common;
                other.Remaining -= common;
                matched += common;
            }
        }

        // A bare C# name (no argument list) that is still unmatched may be a
        // theory xUnit did not pre-enumerate: its rows run as `Name(...)`.
        Dictionary<string, List<NameTally>> unmatchedRowsByMethod = actualTally.Values
            .Where(tally => tally.Remaining > 0 && tally.Key.IndexOf('(') > 0)
            .GroupBy(tally => MethodPart(tally.Key), StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);
        int theoryRows = 0;
        foreach (NameTally bare in expectedTally.Values
            .Where(tally => tally.Remaining > 0 && tally.Key.IndexOf('(') < 0))
        {
            if (!unmatchedRowsByMethod.TryGetValue(bare.Key, out List<NameTally> rows))
            {
                continue;
            }

            // Each outstanding bare occurrence needs at least one row of its
            // own (a multi-targeted listing repeats the bare name); only the
            // rows beyond that are the theory's non-enumerated surplus.
            int available = rows.Sum(row => row.Remaining);
            int satisfied = Math.Min(bare.Remaining, available);
            foreach (NameTally row in rows)
            {
                theoryRows += row.Remaining;
                row.Remaining = 0;
            }

            unmatchedRowsByMethod.Remove(bare.Key);
            matched += satisfied;
            bare.Remaining -= satisfied;
        }

        return new TestNameParityResult(
            expected.Count,
            actualNames.Count,
            matched,
            theoryRows,
            Unmatched(expectedTally),
            Unmatched(actualTally));
    }

    /// <summary>
    /// The method part of a display name: everything before the argument list.
    /// </summary>
    /// <param name="name">A test-case display name.</param>
    /// <returns>The name up to (not including) its first <c>(</c>.</returns>
    public static string MethodPart(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        int open = name.IndexOf('(');
        return open < 0 ? name : name.Substring(0, open);
    }

    private static Dictionary<string, NameTally> Tally(IEnumerable<string> names)
    {
        var tally = new Dictionary<string, NameTally>(StringComparer.Ordinal);
        foreach (string name in names)
        {
            if (name is null)
            {
                continue;
            }

            string key = TestParityComparison.NormalizeTestName(name);
            if (!tally.TryGetValue(key, out NameTally entry))
            {
                entry = new NameTally(key, name);
                tally.Add(key, entry);
            }

            entry.Remaining++;
        }

        return tally;
    }

    private static IReadOnlyList<string> Unmatched(Dictionary<string, NameTally> tally)
    {
        var names = new List<string>();
        foreach (NameTally entry in tally.Values)
        {
            for (int index = 0; index < entry.Remaining; index++)
            {
                names.Add(entry.Display);
            }
        }

        names.Sort(StringComparer.Ordinal);
        return names;
    }

    private sealed class NameTally
    {
        public NameTally(string key, string display)
        {
            this.Key = key;
            this.Display = display;
        }

        public string Key { get; }

        public string Display { get; }

        public int Remaining { get; set; }
    }
}

/// <summary>
/// Issue #4633: the outcome of <see cref="TestNameParity.Compare"/>.
/// </summary>
public sealed class TestNameParityResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TestNameParityResult"/> class.
    /// </summary>
    /// <param name="expectedCount">The number of C# oracle names.</param>
    /// <param name="actualCount">The number of migrated results.</param>
    /// <param name="matched">The number of C# names matched by a migrated result.</param>
    /// <param name="theoryRows">The migrated rows matched to a bare (non-enumerated) C# theory.</param>
    /// <param name="missing">The C# names with no migrated result, sorted.</param>
    /// <param name="extra">The migrated results with no C# name, sorted.</param>
    public TestNameParityResult(
        int expectedCount,
        int actualCount,
        int matched,
        int theoryRows,
        IReadOnlyList<string> missing,
        IReadOnlyList<string> extra)
    {
        this.ExpectedCount = expectedCount;
        this.ActualCount = actualCount;
        this.Matched = matched;
        this.TheoryRows = theoryRows;
        this.Missing = missing ?? Array.Empty<string>();
        this.Extra = extra ?? Array.Empty<string>();
    }

    /// <summary>Gets the number of C# oracle names.</summary>
    public int ExpectedCount { get; }

    /// <summary>Gets the number of migrated results.</summary>
    public int ActualCount { get; }

    /// <summary>Gets the number of C# names matched by a migrated result.</summary>
    public int Matched { get; }

    /// <summary>Gets the migrated rows that matched a bare (non-enumerated) C# theory.</summary>
    public int TheoryRows { get; }

    /// <summary>Gets the C# names the migrated run did not execute, sorted.</summary>
    public IReadOnlyList<string> Missing { get; }

    /// <summary>Gets the migrated results that are not in the C# oracle, sorted.</summary>
    public IReadOnlyList<string> Extra { get; }

    /// <summary>Gets a value indicating whether every name matched in both directions.</summary>
    public bool IsMatch => this.Missing.Count == 0 && this.Extra.Count == 0;
}
