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
/// On a6f5ff7fb, contextual conversions and enclosing compound calls leave stale initializer facts.
/// On 74c10fcee, suppressed null comparisons and optional coalescing-assignment operands fail these runtime/binding oracles.
/// On 36d50e65c, declaration-style for headers and argument mutations in expression statements leave GS0300.
/// Elision and custom-handler traversal mutants cause GS0116 in both review regressions.
/// The C# output oracle also rejects erased null guards and throwing bridges on nullable stores.
/// Each test also compares the translated program's output with C#.
open class Issue5706NarrowedConditionalIndexTests {
    @Fact
    func ContinueEntry_IncludesBracedAndUnbracedRootConditions() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
public static class Demo
{
    static string trace = "";
    static string? Maybe(bool present) => present ? "g" : null;
    static void Record(char? value) { trace += value?.ToString() ?? "_"; }
    static string Unbraced(bool present) { trace = ""; string? s = Maybe(present); for (int i = 0; i < 1; Record(s?[0]), i++) if (s != null) continue; return trace; }
    static string Braced(bool present) { trace = ""; string? s = Maybe(present); for (int i = 0; i < 1; Record(s?[0]), i++) { if (s != null) continue; } return trace; }
    static string Coalesced() { trace = ""; string? s = null; for (int i = 0; i < 1; Record(s?[0]), i++) if ((s ??= "h").Length > 0) continue; return trace; }
    public static string Run() => Unbraced(true) + "|" + Unbraced(false) + "|" + Braced(true) + "|" + Braced(false) + "|" + Coalesced();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "g|_|g|_|h")
    }

    @Fact
    func IncrementorEntry_AppliesBodyAndContinueEffectsBeforePrefixes() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static string trace = "";
    static Action? clear;
    static int disposals;
    sealed class Cleanup : IDisposable { readonly Action action; public Cleanup(Action action) { this.action = action; } public void Dispose() { disposals++; action(); } }
    static void Record(char? value) { trace += value?.ToString() ?? "_"; }
    static char? Second(string? first, char? second) => second;
    static string? Call() { clear?.Invoke(); return null; }
    static string? Maybe(int value) => value == 0 ? "g" : null;
    static void Touch(out int value) { value = 0; }
    static string Cleared() { trace = ""; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(s?[0]), i++) { s = null; } return trace; }
    static string Restored() { trace = ""; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(s?[0]), i++) { s = null; s = "b"; } return trace; }
    static string Continued() { trace = ""; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Record(s?[0]), i++) { if (i == 0) { s = null; continue; } s = "z"; } return trace; }
    static string ContinuedNonNull() { trace = ""; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Record(s?[0]), i++) { if (i == 0) { s = "c"; continue; } s = "d"; } return trace; }
    static string PrefixWritten() { trace = ""; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(Second(s = null, s?[0])), i++) { s = "b"; } return trace; }
    static string PrefixCalled() { trace = ""; string? s = null; clear = () => s = null; for (int i = 0; (s ??= "a").Length > i; Record(Second(Call(), s?[0])), i++) { s = "b"; } return trace; }
    static string GuardedContinue() { trace = ""; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(s?[0]), i++) { s = Maybe(i); if (s != null) { continue; } s = "n"; } return trace; }
    static string Disposed() { trace = ""; disposals = 0; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(s?[0]), i++) { using var cleanup = new Cleanup(() => s = null); s = "b"; } return trace + ":" + disposals; }
    static string OutContinued() { trace = ""; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Touch(out var ignored), Record(s?[0]), i++) { if (i == 0) { s = null; continue; } s = "k"; } return trace; }
    static string OutNonNull() { trace = ""; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Touch(out var ignored), Record(s?[0]), i++) { if (i == 0) { s = "h"; continue; } s = "j"; } return trace; }
    static string SharedRetained() { trace = ""; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Record(s?[0]), i++) { if (i == 0) { try { continue; } catch (Exception) { throw; } } s = "k"; } return trace; }
    static string SharedCleared() { trace = ""; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Record(s?[0]), i++) { if (i == 0) { try { s = null; continue; } catch (Exception) { throw; } } s = "k"; } return trace; }
    static string SharedDisposed() { trace = ""; disposals = 0; string? s = null; for (int i = 0; (s ??= "ab").Length > i; Record(s?[0]), i++) { using (var cleanup = new Cleanup(() => s = null)) { s = "h"; if (i == 0) { continue; } } s = "k"; } return trace + ":" + disposals; }
    static string NativeCleared() { trace = ""; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(s?[0])) { i++; s = null; } return trace; }
    static string NativeRestored() { trace = ""; string? s = null; for (int i = 0; (s ??= "a").Length > i; Record(s?[0])) { i++; s = "b"; } return trace; }
    static string NativePrefix() { trace = ""; string? s = null; for (int i = 0; i < 1; Record(Second(s ??= "p", s?[0]))) { i++; s = null; } return trace; }
    static string NativeIncoming() { trace = ""; string? s = null; s = "a"; for (int i = 0; i < 1; Record(s?[0])) { i++; } return trace; }
    public static string Run() => Cleared() + "|" + Restored() + "|" + Continued() + "|" + ContinuedNonNull() + "|" +
        PrefixWritten() + "|" + PrefixCalled() + "|" + GuardedContinue() + "|" + Disposed() + "|" + OutContinued() + "|" + OutNonNull() + "|" + SharedRetained() + "|" + SharedCleared() + "|" + SharedDisposed() + "|" +
        NativeCleared() + "|" + NativeRestored() + "|" + NativePrefix() + "|" + NativeIncoming();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "_|b|_z|c|_|_|g|_:1|_k|h|ak|_k|_k:2|_|b|p|a")
    }

    @Fact
    func ConditionPrefixes_DoNotPublishCompletedPlainAssignmentFacts() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
public static class Demo
{
    static bool Keep(string? first, char? second) => second.HasValue;
    static bool Three(string? first, char? second, string third) => second.HasValue;
    static string Plain() { string? s = null; if (Keep(s = "a", s?[0])) {} return s?[0] + ""; }
    static string Incoming() { string? s = null; s = "b"; if (Keep(s = "c", s?[0])) {} return s?[0] + ""; }
    static string Coalescing() { string? s = null; if (Keep(s ??= "d", s?[0])) {} return s?[0] + ""; }
    static string Mixed() { string? s = null, other = null; if (Three(s = "e", s?[0], other ??= "x")) {} return s?[0] + ""; }
    public static string Run() => Plain() + "|" + Incoming() + "|" + Coalescing() + "|" + Mixed();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|c|d|e")
    }

    @Fact
    func ExpressionBodies_UseOrderedPrefixesWithoutCrossingCallables() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static char? Second(string first, char? second) => second;
    static char? Read(string? s) => Second(s ??= "a", s?[0]);
    static char? Lambda() { string? s = null; Func<char?> read = () => Second(s ??= "b", s?[0]); return read(); }
    static char? Deferred() { string? s = null; Func<char?> read = () => Second(s ??= "x", s?[0]); return s?[0]; }
    public static string Run() => Read(null) + "|" + Lambda() + "|" + Deferred();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|b|")
    }

    @Fact
    func ConditionExit_CollectsPlainAssignmentsAndLaterInvalidation() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static bool Keep(string value, bool result) => result;
    static bool Invoke(string value, Action action) { action(); return true; }
    static char? Plain(bool result) { string? s = null; if (Keep(s = "a", result)) {} return s?[0]; }
    static char? Changed(bool result) { string? s = null; if (Keep(s = "b", result)) { s = null; } return s?[0]; }
    static char? Captured() { string? s = null; if (Invoke(s = "c", () => s = null)) {} return s?[0]; }
    public static string Run() => Plain(false) + "|" + Plain(true) + "|" + Changed(false) + "|" + Changed(true) + "|" + Captured();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|a|b||")
    }

    @Fact
    func ConstructorEffects_CompleteBeforeInitializerReads() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static Action? clear;
    sealed class Box { public char? Value; public Box(string value) { clear?.Invoke(); } }
    static char? Read(bool reset)
    {
        string? s = null;
        clear = reset ? () => s = null : null;
        var box = new Box(s ??= "a") { Value = s?[0] };
        return box.Value;
    }
    public static string Run() => Read(true) + "|" + Read(false);
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "|a")
    }

    @Fact
    func InitializerReads_PrecedeLoopRegionInvalidation() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
public static class Demo
{
    static void Keep(string value) {}
    static char? Declaration() { string? s = null; for (var pair = ((s ??= "a"), s?[0]);;) { s = null; return pair.Item2; } }
    static char? Expressions() { string? s = null; char? result = null; for (Keep(s ??= "b"), result = s?[0];;) { s = null; return result; } }
    public static string Run() => Declaration() + "|" + Expressions();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|b")
    }

    @Fact
    func DroppedAddressNames_DoNotMakeClosuresEscape() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static partial class Demo
{
    static partial void Skip(Action action);
    static void Keep() {}
    public static string Run()
    {
        string? s = null;
        s = "a";
        Skip(() => { ref string? alias = ref s; });
        Keep();
        return s?[0] + "";
    }
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a")
    }

    @Fact
    func CurrentStatementPrefix_PreservesOrderedAndConditionalEvaluation() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static Action? clear;
    sealed class Token { public static implicit operator Token(string value) { clear?.Invoke(); return new Token(); } }
    static char? Second(string first, char? second) => second;
    static void Keep(string value) {}
    static char? Tuple() { string? s = null; var pair = ((s ??= "a"), s?[0]); return pair.Item2; }
    static char? Argument() { string? s = null; return Second(s ??= "b", s?[0]); }
    static char? Optional(bool enabled) { string? s = null; return enabled ? Second(s ??= "c", s?[0]) : s?[0]; }
    static char? Logical(bool enabled) { string? s = null; var ignored = enabled && Second(s ??= "l", s?[0]) != null; return s?[0]; }
    static char? Declarators() { string? s = null; char? first = (s ??= "f")[0], second = s?[0]; return second; }
    static char? Incrementors() { string? s = null; char? result = null; for (int i = 0; i < 1; Keep(s ??= "i"), result = s?[0], i++) {} return result; }
    static char? Written() { string? s = null; var triple = ((s ??= "d"), s = null, s?[0]); return triple.Item3; }
    static char? Converted() { string? s = null; clear = () => s = null; var pair = ((Token)(s ??= "e"), s?[0]); return pair.Item2; }
    public static string Run() => Tuple() + "|" + Argument() + "|" + Optional(false) + "|" + Optional(true) + "|" +
        Logical(false) + "|" + Logical(true) + "|" + Declarators() + "|" + Incrementors() + "|" + Written() + "|" + Converted();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|b||c||l|f|i||")
    }

    @Fact
    func CurrentStatementPrefix_RespectsOptionalHandlerHoles() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using HandlerLibrary;
public static class Demo
{
    static int holes;
    static string Touch(string value) { holes++; return value; }
    static char? Check(bool enabled, bool append)
    {
        string? s = null;
        Api.Write(enabled, append, $"p{(s ??= Touch("a")) + s?[0]}");
        return s?[0];
    }
    public static string Run() => Check(false, true) + "|" + Check(true, false) + "|" + Check(true, true) +
        "|" + holes + ":" + Api.Constructors + ":" + Api.Appends + ":" + Api.Calls;
}`, `
#nullable enable
using System.Runtime.CompilerServices;
namespace HandlerLibrary;
[InterpolatedStringHandler]
public struct Handler {
    private readonly bool append;
    public Handler(int literalLength, int formattedCount, bool enabled, out bool shouldAppend)
        : this(literalLength, formattedCount, enabled, true, out shouldAppend) {}
    public Handler(int literalLength, int formattedCount, bool enabled, bool append, out bool shouldAppend) {
        this.append = append;
        shouldAppend = enabled;
        Api.Constructors++;
    }
    public bool AppendLiteral(string value) { Api.Appends++; return append; }
    public bool AppendFormatted(string? value) { Api.Appends++; return append; }
}
public static class Api {
    public static int Constructors, Appends, Calls;
    public static void Write(bool enabled, bool append, [InterpolatedStringHandlerArgument("enabled", "append")] Handler handler) { Calls++; }
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "||a|1:3:3:3")
    }

    @Fact
    func ConditionExit_ExportsAssignmentsAndRetainsLaterInvalidation() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static bool Keep(string value, bool result) => result;
    static bool Invoke(string value, Action action) { action(); return true; }
    static char? Plain(bool result) { string? s = null; if (Keep(s ??= "a", result)) {} return s?[0]; }
    static char? Changed(bool result) { string? s = null; if (Keep(s ??= "b", result)) { s = null; } return s?[0]; }
    static char? Captured() { string? s = null; if (Invoke(s ??= "c", () => s = null)) {} return s?[0]; }
    public static string Run() => Plain(false) + "|" + Plain(true) + "|" + Changed(false) + "|" + Changed(true) + "|" + Captured();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|a|b||")
    }

    @Fact
    func ErasedNameOf_PreservesFactsButNotContextualConversionEffects() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
public static class Demo
{
    static Action? clear;
    sealed class Token { public static implicit operator Token(string value) { clear?.Invoke(); return new Token(); } }
    static char? Plain() { string? s = null; Action reset = () => s = null; s = "a"; var name = nameof(s.Length); return s?[0]; }
    static char? Converted() { string? s = null; clear = () => s = null; s = "b"; Token name = nameof(s.Length); return s?[0]; }
    public static string Run() => Plain() + "|" + Converted();
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|")
    }

    @Fact
    func NameOfConversions_InvalidateByReferenceStorage() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
public static class Demo
{
    static string? stored;
    sealed class Token { public static implicit operator Token(string value) { stored = null; return new Token(); } }
    static char? Read(ref string? s, bool convert)
    {
        if (s != null)
        {
            var name = nameof(s.Length);
            if (convert) { Token converted = nameof(s.Length); }
            return s?[0];
        }
        return null;
    }
    static char? Call(bool convert) { stored = "a"; return Read(ref stored, convert); }
    public static string Run() => Call(false) + "|" + Call(true);
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|")
    }

    @Fact
    func DroppedWrites_DoNotEscapeClosuresOrInvalidateLoopFacts() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Diagnostics;
public static partial class Demo
{
    static int effects, calls;
    static partial void Skip(Action action);
    static partial void Skip(string? value);
    [Conditional("OMITTED")] static void Trace(string? value) { calls++; }
    static void Keep() { calls++; }
    static string? Reset() { effects++; return null; }
    static char? Closure() { string? s = null; s = "c"; Skip(() => s = null); Keep(); return s?[0]; }
    static char? ConditionalLoop() { string? s = null; s = "l"; for (int i = 0; i < 2; i++) { Trace(s = Reset()); } return s?[0]; }
    static char? PartialLoop() { string? s = null; s = "p"; for (int i = 0; i < 2; i++) { Skip(s = Reset()); } return s?[0]; }
    public static string Run() => Closure() + "|" + ConditionalLoop() + "|" + PartialLoop() + "|" + effects + ":" + calls;
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "c|l|p|0:1")
    }

    @Fact
    func ElidedCalls_DoNotExportArgumentFactsOrEffects() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#define ACTIVE
#define UNUSED
#define OMITTED
#undef OMITTED
#nullable enable
using System;
using System.Diagnostics;
    public static partial class Demo
    {
        static int arguments, calls;
        static string Touch(string value) { arguments++; return value; }
        static void Keep(string value) { calls++; }
        static partial void Skip(string? value);
        static partial void Implemented(string value);
        static partial void Implemented(string value) { calls++; }
        [Conditional("OMITTED")] static void Trace(string value) { calls++; }
        [Conditional("ACTIVE")] static void TraceOn(string value) { calls++; }
        sealed partial class Receiver
        {
            partial void Skip(string value);
            [Conditional("OMITTED")] void Trace(string value) { calls++; }
            static Receiver Make() { arguments++; return new Receiver(); }
            public static char? Check()
            {
                string? s = null;
                Make()?.Skip(s ??= Touch("x"));
                Make()?.Trace(s ??= Touch("x"));
                return s?[0];
            }
        }
        static char? Plain() { Receiver.Check(); string? s = null; Skip(s ??= Touch("x")); return s?[0]; }
        static char? Header() { string? s = null; for (Skip("x"); false; Skip("x")) {} for (Skip(s ??= Touch("x"));;) { return s?[0]; } }
        static char? Ordinary() { string? s = null; Keep(s ??= Touch("a")); return s?[0]; }
        static char? Lowered() { string? s = null; int i = 0; for (; i < 1; Skip(s ??= Touch("x")), i++) { continue; } return s?[0]; }
        static char? Incoming() { string? s = null; s = "h"; Skip(s = null); Implemented(Touch("z")); return s?[0]; }
        static char? Captured() { string? s = null; Action clear = () => s = null; s = "i"; Skip(Reset(clear)); return s?[0]; }
        static string Reset(Action clear) { clear(); return "x"; }
        static char? Conditional() { string? s = null; Trace(s ??= Touch("x")); return s?[0]; }
        static char? ConditionalHeader() { string? s = null; for (Trace(s ??= Touch("x"));;) { return s?[0]; } }
        static char? Positive() { string? s = null; TraceOn(s ??= Touch("k")); Trace(s = null!); return s?[0]; }
        public static string Run() => Plain() + "|" + Header() + "|" + Ordinary() + "|" + Lowered() + "|" +
            Incoming() + "|" + Captured() + "|" + Conditional() + "|" + ConditionalHeader() + "|" +
            Positive() + "|" + arguments + ":" + calls;
    }
`, rejectConditionalIndexWarnings: true, expectedOutput: "||a||h|i|||k|3:3")
        Assert.Contains(`@Conditional("ACTIVE")`, printed)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("Skip(", printed)
    }

    @Fact
    func HandlerHoles_PreserveConditionalEvaluationAndPossibleEffects() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using System;
using HandlerLibrary;
public static class Demo
{
    static int holes;
    static string Touch(string value) { holes++; return value; }
    static char? Construct(bool enabled)
    {
        string? s = null;
        Api.Write(enabled, $"{s ??= Touch("a")}");
        return s?[0];
    }
    static char? Append(bool append)
    {
        string? s = null;
        Api.Write(true, append, $"p{s ??= Touch("b")}");
        return s?[0];
    }
    static char? Clear(bool enabled)
    {
        string? s = null;
        s = "c";
        Api.Write(enabled, $"{s = null}");
        return s?[0];
    }
    static char? Captured(bool enabled)
    {
        string? s = null;
        s = "d";
        Action clear = () => s = null;
        Api.Write(enabled, $"{Reset(clear)}");
        return s?[0];
    }
    static string Reset(Action clear) { clear(); return "x"; }
    static char? Native()
    {
        string? s = null;
        var text = $"{s ??= "n"}";
        return s?[0];
    }
    public static string Run() => Construct(false) + "|" + Construct(true) + "|" + Append(false) + "|" + Append(true) +
        "|" + Clear(false) + "|" + Clear(true) + "|" + Captured(false) + "|" + Captured(true) + "|" + Native() +
        "|" + holes + ":" + Api.Constructors + ":" + Api.Appends + ":" + Api.Calls;
}`, `
#nullable enable
using System.Runtime.CompilerServices;
namespace HandlerLibrary;
[InterpolatedStringHandler]
public struct Handler {
    private readonly bool append;
    public Handler(int literalLength, int formattedCount, bool enabled, out bool shouldAppend)
        : this(literalLength, formattedCount, enabled, true, out shouldAppend) {}
    public Handler(int literalLength, int formattedCount, bool enabled, bool append, out bool shouldAppend) {
        this.append = append;
        shouldAppend = enabled;
        Api.Constructors++;
    }
    public bool AppendLiteral(string value) { Api.Appends++; return append; }
    public bool AppendFormatted(string? value) { Api.Appends++; return append; }
}
public static class Api {
    public static int Constructors, Appends, Calls;
    public static void Write(bool enabled, [InterpolatedStringHandlerArgument("enabled")] Handler handler) { Calls++; }
    public static void Write(bool enabled, bool append, [InterpolatedStringHandlerArgument("enabled", "append")] Handler handler) { Calls++; }
}`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "|a||b|c||d||n|2:8:6:8")
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func ForDeclarations_ApplyMutationsOnceAndRespectBackedges() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static Action? clear;
        sealed class Token
        {
            public static implicit operator Token(string? value) { clear?.Invoke(); return new Token(); }
        }
        static void Keep(string value) {}
        static char? Exact() { string? s = null; for (var ignored = (s ??= "a");;) { return s?[0]; } }
        static char? ExpressionHeader() { string? s = null; for (Keep(s ??= "e");;) { return s?[0]; } }
        static char? LaterInitializer() { string? s = null; for (string? first = s ??= "l", second = s = null;;) { return s?[0]; } }
        static string Invalidated()
        {
            string? s = null;
            string result = "";
            int count = 0;
            for (var ignored = (s ??= "a"); count < 2; count++) { result += s?[0] + ":"; s = null; }
            return result;
        }
        static string Stable()
        {
            string? s = null;
            string result = "";
            int count = 0;
            for (var ignored = (s ??= "b"); count < 2; count++) { result += s?[0] + ":"; }
            return result;
        }
        static char? Converted()
        {
            string? s = null;
            clear = () => s = null;
            for (Token ignored = s ??= "c";;) { return s?[0]; }
        }
        static char? DeclarationOnly() { for (string? s = "i";;) { return s?[0]; } }
        public static string Run() => Exact() + "|" + ExpressionHeader() + "|" + LaterInitializer() + "|" + Invalidated() + "|" + Stable() + "|" + Converted() + "|" + DeclarationOnly();
    }
}`, "a|e||a::|b:b:||i")
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
    }

    @Fact
    func ExpressionStatements_ApplyArgumentFactsAndTrailingEffects() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static Action? clear;
        sealed class Token
        {
            public static implicit operator Token(string? value) { clear?.Invoke(); return new Token(); }
        }
        static void Keep(string value) {}
        static void Pair(string first, string? second) {}
        static void Invoke(string value, Action action) { action(); }
        static void Convert(Token value) {}
        static char? Plain() { string? s = null; Keep(s ??= "a"); return s?[0]; }
        static char? Written() { string? s = null; Pair(s ??= "b", s = null); return s?[0]; }
        static char? Captured() { string? s = null; Invoke(s ??= "c", () => s = null); return s?[0]; }
        static char? Converted()
        {
            string? s = null;
            clear = () => s = null;
            Convert(s ??= "d");
            return s?[0];
        }
        public static string Run() => Plain() + "|" + Written() + "|" + Captured() + "|" + Converted();
    }
}`, "a|||")
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.Contains("s?[0]", printed)
    }

    @Fact
    func SuppressedNullEquality_PreservesNativeArrayAndStringGuards() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static char? Array(char[]? value) { if (value != null!) return value?[0]; return null; }
        static char? Text(string? value) { if (value != (null!)) return value?[0]; return null; }
        static char? Join(string? value) { if (value == null!) value = "j"; return value?[0]; }
        static string Params(params char[] values) => values != null! ? "p" : "nil";
        public static string Run() =>
            Array(null) + "|" + Array(new[] { 'a' }) + "|" + Text(null) + "|" + Text("s") + "|" +
            Join(null) + "|" + Join("k") + "|" + Params('p');
    }
}`, "|a||s|j|k|p")
        Assert.DoesNotContain("nil!!", printed)
        Assert.DoesNotContain("value?[0]", printed)
    }

    @Fact
    func SuppressedNullEquality_PreservesImportedOperatorDispatch() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#nullable enable
using ObLib5936;
public static class Demo
{
    static char? Equal() { Box? value = null; if (value == null!) value = new Box(); return value?[0]; }
    static char? Unequal() { Box? value = null; if (value != (null!)) {} else value = new Box(); return value?[0]; }
    static char? Left() { Box? value = null; if ((null!) == value) value = new Box(); return value?[0]; }
    static char? Pattern() { Box? value = null; if (value is null) value = new Box(); return value?[0]; }
    public static string Run() => Equal() + "|" + Unequal() + "|" + Left() + "|" + Pattern() + "|" + Box.Calls;
}`, `
#nullable enable
namespace ObLib5936;
public sealed class Box
{
    public static int Calls;
    public static bool operator ==(Box? left, Box? right) { Calls++; return false; }
    public static bool operator !=(Box? left, Box? right) { Calls++; return true; }
    public override bool Equals(object? other) => false;
    public override int GetHashCode() => 0;
    public char this[int index] => 'x';
}`, rejectConditionalIndexWarnings: true)
        Assert.DoesNotContain("nil!!", printed)
        Assert.Contains("cast[Box?](nil)", printed)
        Assert.Contains("value?[0]", printed)
    }

    @Fact
    func ConditionalEvaluation_ExportsOnlyGuaranteedAssignmentFacts() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static int calls;
        static string Touch(string value) { calls++; return value; }
        static string Reset(Action clear) { calls++; clear(); return "r"; }
        static char? And(bool gate)
        {
            string? value = null;
            var result = gate && (value ??= Touch("a")) != null;
            return value?[0];
        }
        static char? Or(bool gate)
        {
            string? value = null;
            var result = gate || (value ??= Touch("o")) != null;
            return value?[0];
        }
        static char? Coalesce(string? seed)
        {
            string? value = null;
            var result = seed ?? (value ??= Touch("c"));
            return value?[0];
        }
        static char? Choice(bool gate)
        {
            string? value = null;
            var result = gate ? (value ??= Touch("t")) : "skip";
            return value?[0];
        }
        static string CoalesceAssign(string? seed)
        {
            string? target = seed, value = null;
            var result = (target ??= (value ??= Touch("q")));
            return target?[0] + ":" + value?[0];
        }
        static char? Invalidate(bool gate)
        {
            string? other = null, value = null;
            value = "p";
            var result = gate ? (value = null) : (other ??= Touch("o"));
            return value?[0];
        }
        static char? InvalidateCoalescing(string? seed)
        {
            string? target = seed, value = null;
            value = "p";
            var result = (target ??= Reset(() => value = null));
            return value?[0];
        }
        static char? Both(bool gate)
        {
            string? value = null;
            var result = gate ? (value ??= Touch("t")) : (value ??= Touch("f"));
            return value?[0];
        }
        public static string Run() =>
            And(false) + ":" + And(true) + "|" + Or(true) + ":" + Or(false) + "|" +
            Coalesce("keep") + ":" + Coalesce(null) + "|" + Choice(false) + ":" + Choice(true) + "|" +
            CoalesceAssign("keep") + ":" + CoalesceAssign(null) + "|" +
            Invalidate(false) + ":" + Invalidate(true) + "|" +
            InvalidateCoalescing("keep") + ":" + InvalidateCoalescing(null) + "|" +
            Both(false) + ":" + Both(true) + "|" + calls;
    }
}`, ":a|:o|:c|:t|k::q:q|p:|p:|f:t|9")
        Assert.Contains("value?[0]", printed)
        Assert.DoesNotContain("target?[0]", printed)
    }

    @Fact
    func InitializerConversions_ApplyAfterAssignmentValues() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static Action? clear;
        sealed class Token
        {
            public static implicit operator Token(string? value) { clear?.Invoke(); return new Token(); }
        }
        static char? Direct()
        {
            string? s = null;
            clear = () => s = null;
            Token value = s ??= "a";
            return s?[0];
        }
        static char? Conditional(bool flag)
        {
            string? s = null;
            clear = () => s = null;
            Token value = flag ? (s ??= "t") : (s ??= "f");
            return s?[0];
        }
        static char? Uncaptured()
        {
            string? s = null;
            Token value = s ??= "u";
            return s?[0];
        }
        static char? Incoming()
        {
            string? s = null;
            s = "i";
            Token value = s ??= "unused";
            return s?[0];
        }
        static char? Existing()
        {
            string? s = null;
            s = "e";
            Token value = s;
            return s?[0];
        }
        public static string Run() =>
            Direct() + "|" + Conditional(true) + "|" + Conditional(false) + "|" + Uncaptured() + "|" +
            Incoming() + "|" + Existing();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

    @Fact
    func InitializerCompoundCalls_CompleteAfterInnerAssignments() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static Action? clear;
        sealed class Box
        {
            public static Box operator +(Box value, string? text) { clear?.Invoke(); return value; }
        }
        static char? Read()
        {
            string? s = null;
            clear = () => s = null;
            var b = new Box();
            var value = (b += (s ??= "a"));
            return s?[0];
        }
        static char? Uncaptured()
        {
            string? s = null;
            var b = new Box();
            var value = (b += (s ??= "u"));
            return s?[0];
        }
        public static string Run() => Read() + "|" + Uncaptured();
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.Contains("cast[char?](s[0])", printed)
    }

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
        private func AssertRunsWithoutConditionalIndexWarning(source string, expectedOutput string? = nil) string {
            let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(source, expectedOutput)
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
