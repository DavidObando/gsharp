// <copyright file="Issue5706NarrowedConditionalIndexTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import Xunit

/// Issue #5706: preserve nullable results without conditional indexing on a non-null receiver.
/// @remarks ADR-0154: disabling the non-null receiver rewrite makes the original five tests fail with GS0300.
/// On 14f1e3aa2, cast receivers throw on nil, and named constant guards cause nullable indexing errors.
/// On 39fcd66c7, void lambda and nested continuation tests fail with invalid nullable System.Void output.
/// On a6ffd4673, mutable captures in nested lambdas fail to bind after an outer guard.
/// Issue #5936: disabling assignment postconditions makes the initial five assignment regressions report GS0300.
/// On 064897012, four review regressions fail, and the 24-step prefix chain exceeds a 30-second test-host limit.
/// On cadefd047, the five nested-store, coalescing-arm, and incoming-contract regressions fail.
/// On 6326b12f6, compound results throw, incoming coalescing values warn, and disposal exits lose nullable storage.
/// The same head fails the by-reference join control. Shared-query mutants reject the bridge regression cases.
/// On 9897d36fc, adjacent effects, initializer mutations and overloaded-null tests fail; the loop-entry mutant fails too.
/// The C# output oracle also rejects erased null guards and throwing bridges on nullable stores.
/// Each test also compares the translated program's output with C#.
open class Issue5706NarrowedConditionalIndexTests {
    @Fact
    func LoopJoins_DoNotRebaseInvalidInheritedProofs() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string Read()
        {
            string? s = null;
            string result = "";
            s = "a";
            for (int i = 0; i < 2; i++)
            {
                if (i == 0) s = "b";
                result += s?[0] + "|";
                s = null;
            }
            return result;
        }
        static string Stable()
        {
            string? s = null;
            string result = "";
            s = "a";
            for (int i = 0; i < 2; i++)
            {
                if (i == 0) s = "s"; else s = "t";
                result += s?[0] + "|";
            }
            return result;
        }
        public static string Run() => Read() + "|" + Stable();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func AdjacentEffects_InvalidateProofsAtExclusiveSpanEnds() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static int indices;
    static int Index() { indices++; return 0; }
    static char? Read()
    {
        Box? s = null;
        s = new Box();s -= new Box();return s?[Index()];
    }
    static char? Nested()
    {
        Box? s = null, other = null;
        other = new Box();s = (other -= new Box());return s?[Index()];
    }
    public static string Run() => Read() + "|" + Nested() + "|" + indices + ":" + Box.Calls;
}`, `
#nullable enable
namespace ObLib5936;
public sealed class Box
{
    public static int Calls;
    public static Box operator -(Box left, Box right) { Calls++; return (Box)(object?)null; }
    public char this[int index] => 'x';
}`, rejectConditionalIndexWarnings: true)
        Assert.Contains("object.ReferenceEquals", printed)
    }

    @Fact
    func InitializerMutations_FollowEvaluationOrderAndKeepLaterInvalidation() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static int Reset(Action clear) { clear(); return 0; }
        static char? Assigned() { string? s = null; var value = (s ??= "a"); return s?[0]; }
        static char? Nested() { string? s = null; var value = ((s ??= "n"), 0); return s?[0]; }
        static char? Conditional(bool flag)
        {
            string? s = null;
            var value = flag ? (s ??= "t") : "u";
            return s?[0];
        }
        static char? Switched(bool flag)
        {
            string? s = null;
            var value = flag switch { true => (s ??= "t"), false => (s ??= "f") };
            return s?[0];
        }
        static char? Replaced()
        {
            string? s = null;
            string? first = (s ??= "a"), second = (s = null);
            return s?[0];
        }
        static char? LaterCall()
        {
            string? s = null;
            var value = ((s ??= "a"), Reset(() => s = null));
            return s?[0];
        }
        static char? EarlierCall()
        {
            string? s = null;
            var value = (Reset(() => s = null), (s ??= "e"));
            return s?[0];
        }
        static char? DeclarationOnly() { string? s = "i"; return s?[0]; }
        public static string Run() =>
            Assigned() + "|" + Nested() + "|" + Conditional(true) + "|" + Conditional(false) + "|" +
            Switched(true) + "|" + Switched(false) + "|" + Replaced() + "|" + LaterCall() + "|" +
            EarlierCall() + "|" + DeclarationOnly();
    }
}`)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
    }

    @Fact
    func EqualityGuards_RejectOverloadedNullTestsButKeepNullPatterns() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static char? Equal() { Box? s = null; if (s == null) { s = new Box(); } return s?[0]; }
    static char? Unequal() { Box? s = null; if (s != null) {} else { s = new Box(); } return s?[0]; }
    static char? InBranch() { Box? s = null; if (s != null) { return s?[0]; } return null; }
    static char? LeftEqual() { Box? s = null; if (null == s) { s = new Box(); } return s?[0]; }
    static char? LeftUnequal() { Box? s = null; if (null != s) {} else { s = new Box(); } return s?[0]; }
    static char? NullPattern() { Box? s = null; if (s is null) { s = new Box(); } return s?[0]; }
    static char? NotNullPattern() { Box? s = null; if (s is not null) {} else { s = new Box(); } return s?[0]; }
    static char? String() { string? s = null; if (s == null) { s = "s"; } return s?[0]; }
    public static string Run() =>
        Equal() + "|" + Unequal() + "|" + InBranch() + "|" + LeftEqual() + "|" + LeftUnequal() + "|" +
        NullPattern() + "|" + NotNullPattern() + "|" + String() + "|" + Box.Calls;
}`, `
#nullable enable
namespace ObLib5936;
public sealed class Box
{
    public static int Calls;
    public static bool operator ==(Box left, Box right) { Calls++; return false; }
    public static bool operator !=(Box left, Box right) { Calls++; return true; }
    public override bool Equals(object? other) => false;
    public override int GetHashCode() => 0;
    public char this[int index] => 'x';
}`, rejectConditionalIndexWarnings: true)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("s[0]", printed)
    }

    @Fact
    func ReferenceAssignmentJoins_KeepStorageAndReadFactsSeparate() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        sealed class C { public int N; }
        static C Fill(ref C? c) { c = null; if (c == null) { c = new C(); } c.N = 1; return c; }
        static char? GuardJoin(ref string? s) { s = null; if (s == null) { s = "g"; } return s?[0]; }
        static char? AssignedJoin(bool flag, ref string? s)
        {
            if (flag) { s = "t"; } else { s = "f"; }
            return s?[0];
        }
        static char? Reestablished(bool flag, ref string? s)
        {
            if (flag) { s = null; }
            s = "r";
            return s?[0];
        }
        static char? Local() { string? s = null; s = "l"; return s?[0]; }
        public static string Run()
        {
            C? c = null;
            string? s = null;
            return Fill(ref c).N + "|" + GuardJoin(ref s) + "|" + AssignedJoin(true, ref s) + "|" +
                AssignedJoin(false, ref s) + "|" + Reestablished(true, ref s) + "|" + Local();
        }
    }
}`)
        Assert.Contains("c!!.N = 1", printed)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Theory
    @InlineData("enable")
    @InlineData("enable annotations")
    @InlineData("disable")
    func AssignmentPostconditions_RemoveOnlyRedundantBridges(nullableMode string) {
        let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp("#nullable " + nullableMode + `
using System;
namespace Demo
{
    public static class P
    {
        sealed class C { public int N = 7; public C? BaseClass; }
        sealed class Box<T> where T : class { public static int Use(T value) => 8; }
        sealed class Target { public string Value { get; set; } = ""; }
        sealed class Shape { public Type ClrType { get; } public Shape(Type type) { ClrType = type; } }
        static C? Maybe() => null;
        static int Use(C c) => c.N;
        static int Argument(C p) { p = Maybe(); if (p == null) { p = new C(); } return Use(p); }
        static int Generic(C p) { p = Maybe(); if (p == null) { p = new C(); } return Box<C>.Use(p); }
        static Target Initializer(string value) { if (value == null) { value = "fallback"; } return new Target { Value = value }; }
        static bool Lockable(Shape type) { if (type == null) return true; return type.ClrType == null || !type.ClrType.IsValueType; }
        static int Walk(C s)
        {
            int count = 0;
            var current = s;
            while (current != null) { count++; current = current.BaseClass; }
            return count;
        }
        public static string Run() =>
            Argument(new C()) + "|" + Generic(new C()) + "|" + Initializer(null).Value + "|" +
            Initializer("v").Value + "|" + Walk(new C { BaseClass = new C() }) + "|" +
            Lockable(null) + "|" + Lockable(new Shape(null)) + "|" + Lockable(new Shape(typeof(int))) + "|" +
            Lockable(new Shape(typeof(string)));
    }
}`, rejectRedundantAssertions: nullableMode != "enable annotations")
        Assert.True(printed.Contains("Use(p)", StringComparison.Ordinal), printed)
        Assert.Contains("Target{Value: value}", printed)
        Assert.DoesNotContain("Use(p!!)", printed)
        Assert.DoesNotContain("current!!.BaseClass", printed)
        Assert.DoesNotContain("type!!.ClrType", printed)
    }

    @Fact
    func CompoundAssignmentResults_DoNotInheritOperandRuntimeProofs() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static int indices;
    static int Index() { indices++; return 0; }
    static char? Read()
    {
        Box b = new Box();
        Box? s = null;
        s = (b -= new Box());
        return s?[Index()];
    }
    public static string Run() => Read() + "|" + indices + ":" + Box.Calls;
}`, `
#nullable enable
namespace ObLib5936;
public sealed class Box
{
    public static int Calls;
    public static Box operator -(Box left, Box right) { Calls++; return (Box)(object?)null; }
    public char this[int index] => 'x';
}`, rejectConditionalIndexWarnings: true)
        Assert.Contains("object.ReferenceEquals", printed)
    }

    @Fact
    func CoalescingValues_PreserveIncomingProofsWithNullableFallbacks() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int calls, indices;
        static string Contract(string? value) => (string)value;
        static string? Seed(string? value) { calls++; return value; }
        static int Index() { indices++; return 0; }
        static char? Known(string? seed)
        {
            string? s = null;
            s = "a";
            return (s ??= Seed(seed))?[Index()];
        }
        static char? Unknown(string? initial, string? seed)
        {
            string? s = null;
            s = Contract(initial);
            return (s ??= Seed(seed))?[Index()];
        }
        static char? Nested(string? seed)
        {
            string? s = null, other = null;
            other = "n";
            s = (other ??= Seed(seed));
            return s?[Index()];
        }
        public static string Run() =>
            Known(null) + "|" + Known("b") + "|" + Unknown(null, null) + "|" +
            Unknown(null, "c") + "|" + Unknown("d", null) + "|" + Nested(null) + "|" + calls + ":" + indices;
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.DoesNotContain("Seed(seed)!!", printed)
    }

    @Fact
    func DisposalExits_InvalidateOnlyFactsThatCleanupCanChange() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
using System.Threading.Tasks;
namespace Demo
{
    public static class P
    {
        sealed class Cleaner : IDisposable, IAsyncDisposable
        {
            readonly Action clear;
            public Cleaner(Action clear) { this.clear = clear; }
            public void Dispose() => clear();
            public ValueTask DisposeAsync() { clear(); return default; }
        }
        static char? Exited()
        {
            string? s = null;
            { using var d = new Cleaner(() => s = null); s = "a"; }
            return s?[0];
        }
        static char? Inside()
        {
            string? s = null;
            using var d = new Cleaner(() => s = null);
            s = "i";
            return s?[0];
        }
        static char? Uncaptured()
        {
            string? s = null;
            { using var d = new Cleaner(() => {}); s = "u"; }
            return s?[0];
        }
        static char? Joined(bool flag)
        {
            string? s = null;
            if (flag) { using var d = new Cleaner(() => s = null); s = "j"; }
            else { s = "e"; }
            return s?[0];
        }
        static async Task<char?> Async()
        {
            string? s = null;
            { await using var d = new Cleaner(() => s = null); s = "a"; }
            return s?[0];
        }
        public static string Run() =>
            Exited() + "|" + Inside() + "|" + Uncaptured() + "|" + Joined(true) + "|" + Joined(false) + "|" +
            Async().GetAwaiter().GetResult();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func NestedReferenceStorageWrites_InvalidateInnerParameterFacts() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        sealed class Holder { public string? Value; }
        static char? Array(ref string? s, string?[] a) { a[0] = s = "x"; return s?[0]; }
        static char? Field(ref string? s, Holder h) { h.Value = s = "f"; return s?[0]; }
        static char? Local(string? s, string?[] a) { a[0] = s = "l"; return s?[0]; }
        public static string Run()
        {
            string? s = null;
            var a = new string?[1];
            var h = new Holder();
            return Array(ref s, a) + ":" + s + ":" + a[0] + "|" +
                Field(ref s, h) + ":" + s + ":" + h.Value + "|" + Local(null, a);
        }
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func CoalescingArmProofs_RecoverConditionalAndSwitchFallbacks() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static char? Conditional(bool flag) { string? s = null; s ??= flag ? "a" : "b"; return s?[0]; }
        static char? Switched(bool flag) { string? s = null; s ??= flag switch { true => "t", false => "f" }; return s?[0]; }
        static char? Nested(bool flag)
        {
            string? s = null, other = null;
            s = (other ??= flag ? "n" : "m");
            return s?[0];
        }
        static char? Nullable(bool flag, string? seed) { string? s = null; s ??= flag ? seed : "r"; return s?[0]; }
        public static string Run() =>
            Conditional(true) + "|" + Conditional(false) + "|" + Switched(true) + "|" + Switched(false) + "|" +
            Nested(true) + "|" + Nested(false) + "|" + Nullable(true, null) + "|" + Nullable(false, null);
    }
}`)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
    }

    @Fact
    func IncomingContracts_CoalescingValuesKeepRuntimeNullGuards() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int calls, indices;
        static string Contract(string? value) { calls++; return (string)value; }
        static int Index() { indices++; return 0; }
        static char? Read(string? seed)
        {
            string? s = null;
            s = Contract(seed);
            return (s ??= Contract(null))?[Index()];
        }
        static char? Known()
        {
            string? s = null;
            s = "k";
            return (s ??= Contract(null))?[Index()];
        }
        public static string Run() => Read(null) + "|" + Read("a") + "|" + Known() + "|" + calls + ":" + indices;
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.DoesNotContain("Contract(nil)!!", printed)
    }

    @Fact
    func ChainedElementAssignments_KeepNullableStorageResultTypes() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static char? Nullable()
        {
            string? s = null;
            var items = new string?[1];
            s = items[0] = "a";
            return s?[0];
        }
        static char? NonNull()
        {
            string? s = null;
            var items = new[] { "n" };
            s = items[0] = "b";
            return s?[0];
        }
        public static string Run() => Nullable() + "|" + NonNull();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("items[0]!!", printed)
    }

    @Fact
    func NestedPlatformStores_DoNotRecoverThroughNullableAssignmentResults() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static string Read(bool nil)
    {
        string? s = null, other = null;
        s = other = Lib.Value(nil);
        return s?[0] + ":" + other?[0];
    }
    static char? Coalesced(string? seed, bool nil)
    {
        string? s = null, other = null;
        s = other = (seed ?? Lib.Value(nil));
        return s?[0];
    }
    static char? Conditional(bool flag, bool nil)
    {
        string? s = null;
        s ??= flag ? Lib.Value(nil) : "r";
        return s?[0];
    }
    public static string Run() =>
        Read(true) + "|" + Read(false) + "|" + Coalesced("c", true) + "|" +
        Coalesced(null, false) + "|" + Conditional(true, true) + "|" + Conditional(false, true);
}`, `
#nullable disable
namespace ObLib5936;
public static class Lib
{
    public static string Value(bool nil) => nil ? null : "x";
}`, rejectConditionalIndexWarnings: true)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("object.ReferenceEquals", printed)
    }

    @Fact
    func RepeatedAssignmentPrefixes_ReuseCompletedNarrowingQueries() {
        let assignments = String.Concat(Enumerable.Repeat("s = flag ? s : \"b\";\n", 24))
        let parenthesized = String.Concat(Enumerable.Repeat("s = (flag ? s : \"b\");\n", 24))
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static char? Read(bool flag, string? seed)
        {
            string? s = seed;
            s = "a";
` + assignments + `
            return s?[0];
        }
        static char? Parenthesized(bool flag, string? seed)
        {
            string? s = seed;
            s = "a";
` + parenthesized + `
            return s?[0];
        }
        static char? Switched(bool flag)
        {
            string? s = null;
            s = flag switch { true => "t", false => "f" };
            return s?[0];
        }
        public static string Run() => Read(true, null) + "|" + Read(false, null) + "|" + Parenthesized(true, null) + "|" + Parenthesized(false, null) + "|" + Switched(true) + "|" + Switched(false);
    }
}`)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
    }

    @Fact
    func AssignmentJoins_InvalidateEffectsAtTheConditionRoot() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static bool Invoke(Action clear) { clear(); return true; }
        static char? Read()
        {
            string? s = null;
            Action clear = () => s = null;
            s = "a";
            if (Invoke(clear)) {}
            return s?[0];
        }
        public static string Run() => Read() + "|end";
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("cast[char?](s[0])", printed)
    }

    @Fact
    func ChainedAssignments_NarrowInnerTargetsBeforeLaterStoreEffects() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static Action? clear;
        sealed class Holder { public string? Value { set { clear?.Invoke(); } } }
        sealed class Token
        {
            public static implicit operator Token(string? value) { clear?.Invoke(); return new Token(); }
        }
        static string Both(string? seed)
        {
            string? s = seed, other = seed;
            s = other = "j";
            return s?[0] + ":" + other?[0];
        }
        static char? Setter()
        {
            string? s = null;
            clear = () => s = null;
            var holder = new Holder();
            holder.Value = s = "j";
            return s?[0];
        }
        static char? Conversion()
        {
            string? s = null;
            clear = () => s = null;
            Token token;
            token = s = "j";
            return s?[0];
        }
        static char? OuterAfterSetter()
        {
            string? s = null;
            clear = () => s = null;
            var holder = new Holder();
            s = holder.Value = (s = "j");
            return s?[0];
        }
        static char? FilteredSetter()
        {
            string? s = null;
            var holder = new Holder();
            try { holder.Value = s = "j"; return s?[0]; }
            catch (Exception) when ((s = null) != null) { return null; }
        }
        public static string Run() => Both(null) + "|" + Setter() + "|" + Conversion() + "|" + OuterAfterSetter() + "|" + FilteredSetter() + "|end";
    }
}`)
        Assert.Contains("cast[char?](other[0])", printed)
        Assert.Contains("s?[0]", printed)
    }

    @Fact
    func CoalescingWrites_PreserveIncomingFactsWithNullableAndPlatformFallbacks() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static char? Nullable(string? seed)
    {
        string? s = null;
        s = "a";
        s ??= seed;
        return s?[0];
    }
    static char? Platform(bool nil)
    {
        string? s = null;
        s = "p";
        s ??= Lib.Value(nil);
        return s?[0];
    }
    public static string Run() => Nullable(null) + "|" + Nullable("n") + "|" + Platform(true) + "|" + Platform(false) + ":" + Lib.Calls;
}`, `
#nullable disable
namespace ObLib5936;
public static class Lib
{
    public static int Calls;
    public static string Value(bool nil) { Calls++; return nil ? null : "q"; }
}`, rejectConditionalIndexWarnings: true)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.DoesNotContain("s?[0]", printed)
    }

    @Fact
    func CoalescingAssignmentValues_RequireALeftOrRightRuntimeProof() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string Contract(string? value) => (string)value;
        static char? Unknown(string? seed)
        {
            string? other = seed, s = null;
            s = (other ??= Contract(null));
            return s?[0];
        }
        static char? Known()
        {
            string? other = null, s = null;
            other = "k";
            s = (other ??= Contract(null));
            return s?[0];
        }
        static char? Fallback()
        {
            string? other = null, s = null;
            s = (other ??= "f");
            return s?[0];
        }
        public static string Run() => Unknown(null) + "|" + Unknown("u") + "|" + Known() + "|" + Fallback() + "|end";
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func AssignmentsAndBranchJoins_NarrowOnlyAfterTheWrite() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string Pick(char value) => "char";
        static string Pick(char? value) => "nullable";
        static string Assigned(string? seed)
        {
            string? s = seed;
            s = "a";
            var value = s?[0];
            return Pick(s?[0]) + ":" + Pick(value) + ":" + value.HasValue;
        }
        static char? Parameter(string? s) { s = "p"; return s?[0]; }
        static char? Coalesced(string? s) { s ??= "c"; return s?[0]; }
        static char? CoalesceValue(string? s) { s = s ?? "v"; return s?[0]; }
        static char? ExitJoin(bool flag, string? s) { if (flag) { s = "e"; } else { return null; } return s?[0]; }
        static char? GuardJoin(string? s) { if (s == null) { s = "g"; } return s?[0]; }
        static char? ForInitialized(string? s) { for (s = "h";;) { return s?[0]; } }
        static char? Chained(string? seed)
        {
            string? s = seed, other = seed;
            s = other = "j";
            return s?[0];
        }
        static char? Joined(bool flag, string? seed)
        {
            string? s = seed;
            if (flag) { s = "t"; } else { s = "f"; }
            return s?[0];
        }
        static char? Nested(bool flag, string? seed)
        {
            string? s = seed;
            { if (flag) { s = "n"; } else { s = "m"; } }
            return s?[0];
        }
        static char? Initialized() { string? s = "i"; return s?[0]; }
        public static string Run() =>
            Assigned(null) + "|" + Parameter(null) + "|" + Coalesced(null) + "|" + Coalesced("b") + "|" +
            Joined(true, null) + "|" + Joined(false, null) + "|" + Nested(true, null) + "|" + Nested(false, null) + "|" +
            Initialized() + "|" + GuardJoin(null) + "|" + GuardJoin("k") + "|" + ForInitialized(null) + "|" + Chained(null) + "|" +
            CoalesceValue(null) + "|" + CoalesceValue("o") + "|" + ExitJoin(true, null) + "|" + ExitJoin(false, null);
    }
}`)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("s!!", printed)
    }

    @Fact
    func AssignmentFacts_EndAtNullableWritesAndControlFlowEntries() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static void Clear(out string? s) { s = null; }
        static void Replace(ref string? s) { s = null; }
        static char? Written(string? seed) { string? s = seed; s = "a"; s = seed; return s?[0]; }
        static char? Out(string? seed) { string? s = seed; s = "a"; Clear(out s); return s?[0]; }
        static char? Ref(string? seed) { string? s = seed; s = "a"; Replace(ref s); return s?[0]; }
        static string Backward()
        {
            string? s = null;
            s = "a";
            string result = "";
        read:
            result += s?[0] + "";
            if (s != null) { s = null; goto read; }
            return result;
        }
        static string BackwardStable()
        {
            string? s = null;
            s = "b";
            string result = "";
        read:
            result += s?[0] + "";
            if (result.Length < 2) goto read;
            return result;
        }
        static char? Bypassed(bool skip)
        {
            string? s = null;
            if (skip) goto read;
            s = "a";
        read:
            return s?[0];
        }
        static string Loop()
        {
            string? s = null;
            s = "a";
            string result = "";
            for (int i = 0; i < 2; i++) { result += s?[0] + ""; s = null; }
            return result;
        }
        static string ForWritten(string? s)
        {
            string result = "";
            for (s = "f"; result.Length < 3; s = null) { result += (s?[0] + "|"); }
            return result;
        }
        static char? Reestablished()
        {
            string? s = null;
            for (int i = 0; i < 1; i++) { s = "r"; return s?[0]; }
            return null;
        }
        public static string Run() =>
            Written(null) + "|" + Written("w") + "|" + Out(null) + "|" + Ref(null) + "|" +
            Backward() + "|" + BackwardStable() + "|" + Bypassed(true) + "|" + Bypassed(false) + "|" + Loop() + "|" + ForWritten(null) + "|" + Reestablished();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func AssignmentFacts_DoNotCrossEscapedCallsFiltersOrMutableCaptureBoundaries() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static Action? clear;
        static void Call() { clear?.Invoke(); }
        static int Getter { get { Call(); return 0; } }
        sealed class C { public C() { Call(); } }
        sealed class Token
        {
            public static Token operator +(Token left, Token right) { Call(); return left; }
        }
        static char? Called()
        {
            string? s = null;
            clear = () => s = null;
            s = "a";
            Call();
            return s?[0];
        }
        static char? Property()
        {
            string? s = null;
            clear = () => s = null;
            s = "a";
            var ignored = Getter;
            return s?[0];
        }
        static char? Constructed()
        {
            string? s = null;
            clear = () => s = null;
            s = "a";
            var ignored = new C();
            return s?[0];
        }
        static char? Filtered()
        {
            string? s = null;
            s = "a";
            try { Call(); return s?[0]; }
            catch (Exception) when ((s = null) != null) { return null; }
        }
        static char? Operator()
        {
            string? s = null;
            clear = () => s = null;
            s = "a";
            var ignored = new Token() + new Token();
            return s?[0];
        }
        static string Captured()
        {
            string? s = null;
            s = "a";
            Func<char?> read = () => s?[0];
            char? before = read();
            s = null;
            return before + ":" + read();
        }
        static char? Reestablished()
        {
            string? s = null;
            clear = () => s = null;
            Call();
            s = "r";
            return s?[0];
        }
        static string LocalFunction()
        {
            string? s = null;
            s = "a";
            char? Read() => s?[0];
            char? before = Read();
            s = null;
            return before + ":" + Read();
        }
        public static string Run() =>
            Called() + "|" + Property() + "|" + Constructed() + "|" + Filtered() + "|" + Operator() + "|" +
            Captured() + "|" + LocalFunction() + "|" + Reestablished();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func ForgivenNullableAssignment_DoesNotBecomeARuntimeAssertion() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        sealed class Token { public static implicit operator string(Token value) => (string)(object?)null; }
        static char? Read(string? seed)
        {
            string? s = seed;
            s = seed!;
            return s?[0];
        }
        static char? Composed(bool flag, string? seed)
        {
            string? s = null;
            s = flag ? seed! : "a";
            return s?[0];
        }
        static char? Coalesced(string? seed)
        {
            string? s = null;
            s ??= seed!;
            return s?[0];
        }
        static char? Cast(string? seed)
        {
            string? s = null;
            s = (string)seed;
            return s?[0];
        }
        static string Contract(string? seed) => (string)seed;
        static char? Called(string? seed)
        {
            string? s = null;
            s = Contract(seed);
            return s?[0];
        }
        static char? Assigned() { string? s = null; s = "a"; return s?[0]; }
        static char? Converted() { string? s = null; s = new Token(); return s?[0]; }
        static char? NullableCast() { string? s = null; s = (string?)"n"; return s?[0]; }
        [System.Diagnostics.CodeAnalysis.AllowNull]
        static string PromotedValue = "a";
        static char? Promoted() { PromotedValue = null; string? s = null; s = PromotedValue!; return s?[0]; }
        public static string Run() =>
            Read(null) + "|" + Read("x") + "|" + Composed(true, null) + "|" + Composed(false, null) + "|" +
            Coalesced(null) + "|" + Coalesced("c") + "|" + Cast(null) + "|" + Cast("d") + "|" +
            Called(null) + "|" + Called("e") + "|" + Converted() + "|" + NullableCast() + "|" + Promoted() + "|" + Assigned() + "|end";
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("seed!!", printed)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("object.ReferenceEquals", printed)
    }

    @Fact
    func PlatformAssignments_KeepTheRuntimeGuardAndDoNotNarrowCoalescingWrites() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static char? Assigned(bool nil)
    {
        string? s = null;
        s = Lib.Value(nil);
        return s?[0];
    }
    static char? Coalesced(bool nil)
    {
        string? s = null;
        s ??= Lib.Value(nil);
        return s?[0];
    }
    public static string Run() => Assigned(true) + "|" + Assigned(false) + "|" + Coalesced(true) + "|" + Coalesced(false);
}`, `
#nullable disable
namespace ObLib5936;
public static class Lib
{
    public static string Value(bool nil) => nil ? null : "a";
}`, rejectConditionalIndexWarnings: true)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("Lib.Value(nil)!!", printed)
    }

    @Fact
    func NarrowedLocalsAndParameters_PreserveNullableValueTypes() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string Pick(char value) => "char";
        static string Pick(char? value) => "nullable";
        static string Local(string? seed)
        {
            string? s = seed;
            if (s != null)
            {
                var c = s?[0];
                return Pick(s?[0]) + ":" + c.HasValue + ":" + Pick(c) + ":" + (s?[0]).HasValue;
            }
            return "nil";
        }
        static char? Parameter(string? s) { if (s != null) { return s?[0]; } return null; }
        static char? TypeTest(string? s) { if (s is string) { return s?[0]; } return null; }
        static char? Binding(string? s) { if (s is string value) { return value?[0]; } return null; }
        static char? Constant(string? s) { if (s is "a") { return s?[0]; } return null; }
        static char? Switched(string? s) => s switch { "a" => s?[0], _ => null };
        static char? EarlyExit(string? s) { if (s == null) { return null; } return s?[0]; }
        static string Infer<T>(System.Func<T> value) => typeof(T).Name;
        static string Lambda(string? s) { if (s != null) { return Infer(() => s?[0]); } return "nil"; }
        static string InnerLambda(string? s) => Infer(() => { if (s != null) { return s?[0]; } return null; });
        public static string Run() =>
            Local("a") + " " + Local(null) + " " + Parameter("b") + " " + Parameter(null) + " " +
            TypeTest("c") + " " + Binding("d") + " " + Constant("a") + " " + Switched("a") + " " +
            EarlyExit("e") + " " + Lambda("f") + " " + InnerLambda("g");
    }
}`)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func ArrayAndIndexerElements_PreserveValueAndReferenceNullability() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static int? Array(int[]? a) { if (a != null) { return a?[0]; } return null; }
        static int? Collection(List<int>? a) { if (a != null) { var x = a?[0]; return x; } return null; }
        static int? NullableElement(int?[]? a) { if (a != null) { return a?[0]; } return null; }
        static string? ReferenceElement(string[]? a) { if (a != null) { return a?[0]; } return null; }
        static string? NullableReferenceElement(string?[]? a) { if (a != null) { return a?[0]; } return null; }
        public static string Run() =>
            Array(new[] { 4 }) + " " + Collection(new List<int> { 5 }) + " " + NullableElement(new int?[] { null }) + " " +
            NullableElement(new int?[] { 6 }) + " " + ReferenceElement(new[] { "x" }) + " " +
            NullableReferenceElement(new string?[] { null }) + " " + Array(null) + " " + ReferenceElement(null) + "end";
    }
}`)
        Assert.Contains("cast[int32?](a[0])", printed)
        Assert.Contains("cast[string?](a[0])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func Continuations_LiftOnlyTheFinalResultAndKeepInnerNullChecks() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public class Cell { public static int Touched; public void Touch() { Touched++; } }
    public static class P
    {
        static int indices;
        static int Index() { indices++; return 0; }
        static string? Text(string? s) { if (s != null) { return s?[Index()].ToString(); } return null; }
        static int? Length(string?[]? a) { if (a != null) { return a?[Index()]?.Length; } return null; }
        static char? Nested(string[]? a) { if (a != null) { return a?[Index()][1]; } return null; }
        static char? NestedConditional(string[]? a) { if (a != null) { return a?[Index()]?[1]; } return null; }
        static int? Chained(string?[]? a) { if (a != null) { return a?[Index()]?.ToString().Length; } return null; }
        static void Void(Cell[]? a) { if (a != null) { a?[Index()].Touch(); } }
        public static string Run()
        {
            Void(new[] { new Cell() });
            Void(null);
            return Text("a") + " " + Text(null) + " " + Length(new string?[] { null }) + " " +
                Length(new string?[] { "ab" }) + " " + Nested(new[] { "xy" }) + " " + NestedConditional(new[] { "xy" }) + " " +
                Chained(new string?[] { null }) + " " + Cell.Touched + " " + indices;
        }
    }
}`)
        Assert.Contains("s[Index()].ToString()", printed)
        Assert.Contains("a[Index()]?.Length", printed)
        Assert.Contains("cast[char?](a[Index()][1])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func OtherNonNullableReceivers_RemoveOnlyTheRedundantHop() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int calls;
        static string Get() { calls++; return "ab"; }
        static char? NonNull(string s) => s?[0];
        static char? Created() => new[] { 'x' }?[0];
        static char? Call() => Get()?[0];
        static char? Conditional(string? s) => (s ?? "z")?[0];
        static char? Maybe(string? s) => s?[0];
        static char? MutableLambda(string? s)
        {
            if (s != null) { System.Func<char?> read = () => s?[0]; s = null; return read(); }
            return null;
        }
        static char? InnerWrite(string? s)
        {
            System.Func<char?> read = () => { if (s != null) { s = null; return s?[0]; } return null; };
            return read();
        }
        public static string Run() =>
            NonNull("a") + " " + Created() + " " + Call() + " " + Conditional(null) + " " +
            Maybe(null) + " " + Maybe("c") + " " + MutableLambda("m") + " " + InnerWrite("w") + " " + calls;
    }
}`)
        Assert.Contains("object.ReferenceEquals(s, nil)", printed)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("Get()?[", printed)
    }

    @Fact
    func CheckedCastReceivers_KeepNullGuardsAndEvaluateIndicesOnlyAfterTheGuard() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int receivers;
        static int indices;
        static object? Get(object? value) { receivers++; return value; }
        static int Index() { indices++; return 0; }
        static char? Read(object? value) => ((string)value)?[Index()];
        static char? Captured(object? value) => ((string)Get(value))?[Index()];
        static int? Continued(object? value) => ((string)Get(value))?[Index()].GetHashCode();
        static int? Nested(object? value) => ((string?[])Get(value))?[Index()]?.Length;
        static char? Conditional(bool run, object? value) => run ? ((string)Get(value))?[Index()] : null;
        public static string Run() =>
            Read(null) + "|" + Read("a") + "|" + Captured(null) + "|" + Captured("b") + "|" +
            Continued(null) + "|" + Continued("c") + "|" + Nested(null) + "|" +
            Nested(new string?[] { null }) + "|" + Nested(new string?[] { "ab" }) + "|" +
            Conditional(false, "x") + "|" + Conditional(true, null) + "|" + Conditional(true, "d") + "|" +
            receivers + ":" + indices;
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func NonNullableContracts_StillGuardNullValuesAndVoidContinuations() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public class Cell { public static int Touched; public void Touch() { Touched++; } }
    public static class P
    {
        static int receivers;
        static int indices;
        static int Index() { indices++; return 0; }
        static string Get(object? value) { receivers++; return (string)value; }
        static char? Parameter(string s) => s?[Index()];
        static char? Result(object? value) => Get(value)?[Index()];
        static void Void(object? value) { ((Cell[])value)?[Index()].Touch(); }
        public static string Run()
        {
            Void(null);
            Void(new[] { new Cell() });
            return Parameter((string)(object?)null) + "|" + Parameter("a") + "|" +
                Result(null) + "|" + Result("b") + "|" + receivers + ":" + indices + ":" + Cell.Touched;
        }
    }
}`)
        Assert.Contains("object.ReferenceEquals(s, nil)", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func NamedConstantGuards_DoNotImplyGSharpTypeTestNarrowing() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const string K = "a";
        static char? Read(string? s) { if (s is K) { return s?[0]; } return null; }
        public static string Run() => Read("a") + "|" + Read("b") + "|" + Read(null) + "|end";
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("cast[char?](s[0])", printed)
    }

    @Fact
    func VoidExpressionBodies_UseGuardedBlocksWithoutNullableVoidResults() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public class Cell { public static int Touched; public void Touch() { Touched++; } }
    public static class P
    {
        static int receivers;
        static int indices;
        static int Index() { indices++; return 0; }
        static Cell[] Get(Cell[] cells) { receivers++; return cells; }
        static void Lambda(Cell[] cells)
        {
            Action f = () => cells?[Index()].Touch();
            f();
        }
        static void Captured(Cell[] cells)
        {
            Action f = () => Get(cells)?[Index()].Touch();
            f(); f();
        }
        static void Method(Cell[] cells) => cells?[Index()].Touch();
        public static string Run()
        {
            var missing = (Cell[])(object?)null;
            var present = new[] { new Cell() };
            Lambda(missing); Lambda(present);
            Captured(missing); Captured(present);
            Method(missing); Method(present);
            return Cell.Touched + ":" + receivers + ":" + indices;
        }
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.DoesNotContain("System.Void", printed)
        Assert.DoesNotContain("default(void", printed)
    }

    @Fact
    func NestedVoidContinuations_GuardBothIndexReceiversWithoutNullableResults() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public class Cell { public static int Touched; public void Touch() { Touched++; } }
    public static class P
    {
        static int receivers;
        static int indices;
        static int Index() { indices++; return 0; }
        static Cell[][] Get(Cell[][] cells) { receivers++; return cells; }
        static void Statement(Cell[][] cells) { Get(cells)?[Index()]?[Index()].Touch(); }
        static void Method(Cell[][] cells) => cells?[Index()]?[Index()].Touch();
        static void Lambda(Cell[][] cells)
        {
            Action f = () => Get(cells)?[Index()]?[Index()].Touch();
            f(); f();
        }
        public static string Run()
        {
            var missing = (Cell[][])(object?)null;
            var missingInner = new[] { (Cell[])(object?)null };
            var present = new[] { new[] { new Cell() } };
            Statement(missing); Statement(missingInner); Statement(present);
            Method(missing); Method(missingInner); Method(present);
            Lambda(missing); Lambda(missingInner); Lambda(present);
            return Cell.Touched + ":" + receivers + ":" + indices;
        }
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.DoesNotContain("System.Void", printed)
        Assert.DoesNotContain("default(void", printed)
    }

    @Fact
    func NestedLambdas_CheckCaptureMutabilityInTheDeclaringScope() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static string Local()
        {
            string? s = "a";
            Func<Func<char?>> make = () => { if (s != null) return () => s?[0]; return () => null; };
            var read = make();
            var before = read();
            s = null;
            return before + "->" + read();
        }
        static string Parameter(string? s)
        {
            Func<Func<char?>> make = () => { if (s != null) return () => s?[0]; return () => null; };
            var read = make();
            var before = read();
            s = null;
            return before + "->" + read();
        }
        static char? ReadOnly(string? seed)
        {
            string? s = seed;
            Func<Func<char?>> make = () => { if (s != null) return () => s?[0]; return () => null; };
            return make()();
        }
        public static string Run() =>
            Local() + "|" + Parameter("b") + "|" + Parameter(null) + "|" + ReadOnly("r") + "|" + ReadOnly(null) + "|end";
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func NullableAndPromotedMembers_KeepNativeConditionalIndices() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Punctuation
    {
        public string?[] Infix = Array.Empty<string?>();
        public string?[]? NullableField;
        [AllowNull] public string?[] PromotedField = Array.Empty<string?>();
        [AllowNull] public string?[] PromotedProperty { get; set; } = Array.Empty<string?>();
    }
    public static class P
    {
        static int indices;
        static int Index() { indices++; return 0; }
        static string? ReadNonNull(Punctuation punct) => punct.Infix?[Index()];
        static string? ReadNullable(Punctuation punct) => punct.NullableField?[Index()];
        static string? ReadField(Punctuation punct) => punct.PromotedField?[Index()];
        static string? ReadProperty(Punctuation punct) => punct.PromotedProperty?[Index()];
        public static string Run()
        {
            var punct = new Punctuation { Infix = new string?[] { "a" }, PromotedField = null, PromotedProperty = null };
            var before = ReadNonNull(punct) + "|" + ReadNullable(punct) + "|" + ReadField(punct) + "|" + ReadProperty(punct) + ":" + indices;
            punct.NullableField = new string?[] { "b" };
            punct.PromotedField = new string?[] { null };
            punct.PromotedProperty = new string?[] { "c" };
            return before + ";" + ReadNullable(punct) + "|" + ReadField(punct) + "|" + ReadProperty(punct) + ":" + indices;
        }
    }
}`)
        Assert.Contains("punct.NullableField?[", printed)
        Assert.Contains("punct.PromotedField?[", printed)
        Assert.Contains("punct.PromotedProperty?[", printed)
        Assert.DoesNotContain("punct.Infix?[", printed)
    }

    @Fact
    func GuardedMembers_UseTheSharedStablePathNarrowing() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public class Holder { public readonly string? Text; public Holder(string? text) { Text = text; } }
    public static class P
    {
        static bool Guard(Holder h) => h.Text != null && (h.Text?[0]).HasValue;
        public static string Run() => Guard(new Holder("a")) + " " + Guard(new Holder(null));
    }
}`)
        Assert.Contains("cast[char?](h.Text[0])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    shared {
        private func AssertRunsWithoutConditionalIndexWarning(source string) string {
            let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(source)
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5706", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Snippet.gs")
                File.WriteAllText(sourcePath, printed)
                let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
                Assert.NotNull(compiler)
                let result = GscInvoker(compiler!!).Compile(
                    []string{sourcePath},
                    Path.Combine(directory, "Snippet.dll"),
                    TargetKind.Library,
                    Array.Empty[string]()
                )
                Assert.True(result.Succeeded, result.Output)
                Assert.True(!result.Output.Contains("GS0300", StringComparison.Ordinal), result.Output + "\n" + printed)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
            return printed
        }
    }
}
