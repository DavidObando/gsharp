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
    func ParenthesizedSubjects_KeepAssertionsOnTheOriginalLocal() {
        let printed = AssertRuns(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int Positive(string? current) { if ((current) is ['a']) { return current.Length; } return 0; }
        static int Negative(string? current) { if ((current) is not ['a']) { return 0; } return current.Length; }
        static int NilGuard(string? current) { if ((current) is not null) { return current.Length; } return 0; }
        public static string Run() =>
            Positive("a") + " " + Positive(null) + " " + Negative("a") + " " + Negative(null) + " " + NilGuard("bb");
    }
}`, "1 0 1 0 2")
        Assert.Contains("return current!!.Length", printed)
    }

    @Fact
    func VarDiscards_UseTheSameListEligibilityAsOtherBooleanPatterns() {
        let printed = AssertRuns(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int Positive(string? current) { if (current is ['a', var _]) { return current.Length; } return 0; }
        static int Negative(string? current) { if (current is not ['a', var _]) { return 0; } return current.Length; }
        public static string Run() => Positive("ab") + " " + Positive(null) + " " + Negative("ab") + " " + Negative(null);
    }
}`, "2 0 2 0")
        Assert.DoesNotContain("current is ['a'", printed)
        Assert.DoesNotContain("current!!", printed)
    }

    @Fact
    func NullableGenericListInputs_AreGuardedInBooleanAndSwitchTests() {
        AssertRuns(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static int Positive<T>(T? current) where T : IReadOnlyList<int> { if (current is [1]) { return current.Count; } return 0; }
        static int Arm<T>(T? current) where T : IReadOnlyList<int> => current switch { [1] => current.Count, _ => 0 };
        public static string Run() =>
            Positive<List<int>>(new List<int> { 1 }) + " " + Positive<List<int>>(null) + " " +
            Arm<List<int>>(new List<int> { 1 }) + " " + Arm<List<int>>(null);
    }
}`, "1 0 1 0")
    }

    @Fact
    func NullableValueListPatterns_KeepOneMutableMatchedValue() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public struct Buffer
    {
        private int reads;
        public int Count { get { reads++; return 1; } }
        public int this[int index] => reads;
    }
    public static class P
    {
        static bool Matches(Buffer? current) => current is [1];
        static bool Plain(Buffer current) => current is [1];
        static string Pick(Buffer? current) => "nullable";
        static string Pick(Buffer current) => "plain";
        static string Body(Buffer? current)
        {
            if (current is [1]) { return Pick(current) + " " + current.HasValue + " " + current.Value[0]; }
            return "nil";
        }
        public static string Run() =>
            Matches(new Buffer()) + " " + Matches(null) + " " + Plain(new Buffer()) + " " + Body(new Buffer()) + " " + Body(null);
    }
}`, "True False True nullable True 0 nil")
    }

    @Fact
    func LoweredSlicePatterns_ReadTheBoundCountOnce() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public sealed class Buffer
    {
        public int Reads;
        public int Count { get { Reads++; return Reads == 1 ? 3 : 100; } }
        public int this[int index] => index == 0 ? 1 : index == 2 ? 3 : 0;
    }
    public static class P
    {
        static bool Matches(Buffer? current) => current is [1, .., 3];
        public static string Run()
        {
            var buffer = new Buffer();
            bool matches = Matches(buffer);
            return matches + " " + buffer.Reads + " " + Matches(null);
        }
    }
}`, "True 1 False")
    }

    @Fact
    func NullableValueListCopies_FoldNullTestCombinations() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public struct Buffer
    {
        private int reads;
        public int Count { get { reads++; return 1; } }
        public int this[int index] => reads;
    }
    public static class P
    {
        static bool And(Buffer? current) => current is not null and [1];
        static bool OrLeft(Buffer? current) => current is null or [1];
        static bool OrRight(Buffer? current) => current is [1] or null;
        static bool Not(Buffer? current) => current is not (null or [1]);
        public static string Run() =>
            And(new Buffer()) + " " + And(null) + " " + OrLeft(new Buffer()) + " " + OrLeft(null) + " " +
            OrRight(new Buffer()) + " " + OrRight(null) + " " + Not(new Buffer()) + " " + Not(null);
    }
}`, "True False True True True True False False")
    }

    @Fact
    func ListElementBindings_CaptureBeforeLaterGettersAndBodyWrites() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public sealed class Buffer
    {
        private readonly int[] values = { 1, 3 };
        public int Count => values.Length;
        public int this[int index] { get { if (index == 1) { values[0] = 2; } return values[index]; } }
    }
    public struct MutableBuffer
    {
        private int reads;
        public int Count { get { reads++; return 1; } }
        public int this[int index] => reads;
    }
    public static class P
    {
        static int Body(int[]? current) { if (current is [var first]) { current[0] = 2; return first; } return 0; }
        static int Later(Buffer? current) { if (current is [var first, 3]) { return first; } return 0; }
        static int Typed(object[]? current) { if (current is [int first]) { current[0] = 2; return first; } return 0; }
        static int Value(MutableBuffer? current) { if (current is [var first]) { return first; } return 0; }
        static int Assigned(int[]? current) { if (current is [var first]) { current[0] = 9; first++; return first; } return 0; }
        static int Text(string[]? current) { if (current is [var first]) { current[0] = "changed"; return first.Length; } return 0; }
        static string MaybeText(string?[]? current)
        {
            if (current is [var first]) { current[0] = "changed"; return first ?? "nil"; }
            return "missing";
        }
        public static string Run() =>
            Body(new[] { 1 }) + " " + Body(null) + " " + Later(new Buffer()) + " " + Typed(new object[] { 1 }) + " " +
            Text(new[] { "a" }) + " " + MaybeText(new string?[] { "a" }) + " " + MaybeText(new string?[1]) + " " +
            Value(new MutableBuffer()) + " " + Value(null) + " " + Assigned(new[] { 1 });
    }
}`, "1 0 1 1 1 a nil 1 0 2")
    }

    @Fact
    func ListSliceBindings_SnapshotBeforeReceiverReassignment() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string Text(string? current)
        {
            if (current is ['a', .. var rest]) { current = "cd"; return rest; }
            return "nil";
        }
        static int Array(int[]? current)
        {
            if (current is [1, .. var rest]) { current = new[] { 3, 4 }; return rest[0]; }
            return 0;
        }
        static string Plain(string current)
        {
            if (current is ['a', .. var rest]) { current = "cd"; return rest; }
            return "nil";
        }
        static string Typed(string? current)
        {
            if (current is ['a', .. string rest]) { current = "cd"; return rest; }
            return "nil";
        }
        public static string Run() =>
            Text("ab") + " " + Text(null) + " " + Array(new[] { 1, 2 }) + " " + Array(null) + " " +
            Plain("ab") + " " + Typed("ab");
    }
}`, "b nil 2 0 b b")
    }

    @Fact
    func ListDiscardPatterns_DoNotReadThrowingIndexer() {
        AssertRuns(`
#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
namespace Demo
{
    public sealed class Buffer : IReadOnlyList<int>
    {
        public int Count => 1;
        public int this[int index] => throw new InvalidOperationException();
        public IEnumerator<int> GetEnumerator() => throw new InvalidOperationException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    public static class P
    {
        static bool Plain(IReadOnlyList<int>? current) => current is [_];
        static bool Var(IReadOnlyList<int>? current) => current is [var _];
        static bool Grouped(IReadOnlyList<int>? current) => current is [(var _)];
        public static string Run() =>
            Plain(new Buffer()) + " " + Var(new Buffer()) + " " + Grouped(new Buffer()) + " " +
            Plain(null) + " " + Var(null) + " " + Grouped(null);
    }
}`, "True True True False False False")
    }

    @Fact
    func WholeValueAndNegatedBindings_PreserveMatchedValues() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public struct Buffer
    {
        public int Count => 1;
        public int this[int index] => 1;
    }
    public static class P
    {
        static int Text(string? current)
        {
            if (current is ['a'] matched) { return matched.Length; }
            return 0;
        }
        static int Value(Buffer? current)
        {
            if (current is [1] matched) { return matched.Count; }
            return 0;
        }
        static int Negative(string? current)
        {
            if (current is not [var first]) { return 0; }
            return first;
        }
        public static string Run() =>
            Text("a") + " " + Text(null) + " " + Value(new Buffer()) + " " + Value(null) + " " +
            Negative("a") + " " + Negative(null);
    }
}`, "1 0 1 0 97 0")
    }

    @Fact
    func GroupedListBindings_PreserveReferenceNullabilityAndSnapshots() {
        AssertRuns(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int Positive(string[]? current)
        {
            if (current is [((var first))]) { current[0] = "different"; return first.Length; }
            return 0;
        }
        static int Negative(string[]? current)
        {
            if (current is not [(var first)]) { return 0; }
            current[0] = "different";
            return first.Length;
        }
        static int Slice(string? current)
        {
            if (current is not ['a', .. ((var rest))]) { return 0; }
            current = "different";
            return rest.Length;
        }
        static int NullableElement(string?[]? current)
        {
            if (current is not [((var first))]) { return 0; }
            return first?.Length ?? -1;
        }
        public static string Run() =>
            Positive(new[] { "abc" }) + " " + Positive(null) + " " +
            Negative(new[] { "abc" }) + " " + Negative(null) + " " +
            Slice("ab") + " " + Slice(null) + " " +
            NullableElement(new string?[] { null }) + " " + NullableElement(null);
    }
}`, "3 0 3 0 1 0 -1 0")
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
