// <copyright file="Issue5684NullableListPatternTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import Xunit

/// Issue #5684: lowered list tests guard nullable inputs, and receiver reads use the emitted test's narrowing.
open class Issue5684NullableListPatternTests {
    @Fact
    func NullableStringListPatterns_GuardAndNarrowTheInput() {
        let printed = AssertRuns(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int ListTop(string? current) { if (current is ['a']) { return current.Length; } return 0; }
        static int ListAnd(string? current) { if (current is "a" and ['a']) { return current.Length; } return 0; }
        public static string Run() => ListTop("a") + " " + ListAnd("a") + " " + ListTop(null);
    }
}`, "1 1 0")
        Assert.Contains("current != nil && (current.Length == 1 && current[0] == 'a')", printed)
        Assert.DoesNotContain("current!!", printed)
    }

    @Fact
    func ListPatternCombinations_KeepTheirPositiveAndNegativeFlow() {
        let printed = AssertRuns(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int NullAnd(string? current) { if (current is not null and ['a']) { return current.Length; } return 0; }
        static int Local(string? seed) { string? current = seed; if (current is ['a']) { return current.Length; } return 0; }
        static int PropertyAnd(string? current) { if (current is { Length: > 0 } and ['a']) { return current.Length; } return 0; }
        static int TypeAnd(string? current) { if (current is string and ['a']) { return current.Length; } return 0; }
        static int Not(string? current) { if (current is not ['a']) { return 0; } else { return current.Length; } }
        static int EarlyExit(string? current) { if (current is not ['a']) { return 0; } return current.Length; }
        static int Conditional(string? current) => current is ['a'] ? current.Length : 0;
        static int AndAlso(string? current) { if (current is ['a'] && current.Length > 0) { return current.Length; } return 0; }
        static int Or(string? current) { if (current is ['a'] or ['b']) { return current.Length; } return 0; }
        static int Loop(string? current) { int n = 0; while (current is ['a']) { n += current.Length; current = null; } return n; }
        public static string Run() =>
            NullAnd("a") + " " + NullAnd(null) + " " + PropertyAnd("a") + " " + PropertyAnd(null) + " " +
            TypeAnd("a") + " " + TypeAnd(null) + " " + Not("a") + " " + Not(null) + " " + Not("b") + " " +
            EarlyExit("a") + " " + Conditional("a") + " " + Conditional(null) + " " + AndAlso("a") + " " +
            Or("b") + " " + Or(null) + " " + Loop("a") + " " + Local("a") + " " + Local(null);
    }
}`, "1 0 1 0 1 0 1 0 0 1 1 0 1 1 0 1 1 0")
        Assert.DoesNotContain("current!!", printed)
        Assert.DoesNotContain("current != nil && (current != nil", printed)
        Assert.DoesNotContain("current is string && (current != nil", printed)
    }

    @Fact
    func NullableCollectionsAndValues_UseTheirBoundLengthMember() {
        let printed = AssertRuns(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public struct Buffer
    {
        public int Count => 1;
        public int this[int index] => 1;
    }
    public static class P
    {
        static int Array(int[]? current) { if (current is [1]) { return current.Length; } return 0; }
        static int Items(List<int>? current) { if (current is [1]) { return current.Count; } return 0; }
        static int Interface(IReadOnlyList<int>? current) { if (current is [1]) { return current.Count; } return 0; }
        static bool Value(Buffer? current) => current is [1];
        static bool NotValue(Buffer? current) => current is not [1];
        public static string Run() =>
            Array(new[] { 1 }) + " " + Array(null) + " " + Items(new List<int> { 1 }) + " " + Items(null) + " " +
            Interface(new List<int> { 1 }) + " " + Interface(null) + " " + Value(new Buffer()) + " " + Value(null) + " " +
            NotValue(new Buffer()) + " " + NotValue(null);
    }
}`, "1 0 1 0 1 0 True False False True")
        Assert.Contains("current.Count == 1", printed)
    }

    @Fact
    func NonNullListInputs_DoNotAcquireNilGuards() {
        let printed = AssertRuns(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static bool Text(string current) => current is ['a'];
        static bool Array(int[] current) => current is [1];
        static bool Items(List<int> current) => current is [1];
        public static string Run() =>
            Text("a") + " " + Text("b") + " " + Array(new[] { 1 }) + " " + Array(new int[0]) + " " + Items(new List<int> { 1 });
    }
}`, "True False True False True")
        Assert.DoesNotContain("!= nil", printed)
        Assert.DoesNotContain("!!", printed)
    }

    @Fact
    func ListPatternSubjects_AreEvaluatedOnceAtTheTest() {
        let printed = AssertRuns(`
#nullable enable
namespace Demo
{
    public sealed class Box
    {
        public int Reads;
        public string? Text { get { Reads++; return Reads == 1 ? "a" : null; } }
    }
    public static class P
    {
        static int calls;
        static string? GetNullableString() { calls++; return calls == 1 ? "a" : null; }
        public static string Run()
        {
            var box = new Box();
            bool member = box.Text is ['a'];
            bool call = GetNullableString() is ['a'];
            bool nilCall = GetNullableString() is not ['a'];
            bool skipped = false && GetNullableString() is ['a'];
            return member + " " + box.Reads + " " + call + " " + nilCall + " " + calls + " " + skipped;
        }
    }
}`, "True 1 True True 2 False")
        Assert.Contains("is var __spill", printed)
    }

    @Fact
    func NullableSwitchListArms_PreserveRuntimeMatches() {
        AssertRuns(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static int Text(string? current) => current switch { ['a'] => current.Length, _ => 0 };
        static int Array(int[]? current) => current switch { [1] => current.Length, _ => 0 };
        static int Items(List<int>? current) => current switch { [1] => current.Count, _ => 0 };
        static int Statement(string? current) { switch (current) { case ['a']: return current.Length; default: return 0; } }
        public static string Run() =>
            Text("a") + " " + Text(null) + " " + Array(new[] { 1 }) + " " + Array(null) + " " +
            Items(new List<int> { 1 }) + " " + Items(null) + " " + Statement("a") + " " + Statement(null);
    }
}`, "1 0 1 0 1 0 1 0")
    }

    shared {
        private func AssertRuns(
            source string,
            expected string
        ) string -> Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(
            source,
            expected,
            rejectRedundantAssertions: true
        )
    }
}
