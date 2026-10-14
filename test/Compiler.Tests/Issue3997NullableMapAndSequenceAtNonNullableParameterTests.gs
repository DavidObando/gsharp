// <copyright file="Issue3997NullableMapAndSequenceAtNonNullableParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3997: a nullable `map[K, V]?` / `(sequence[T])?` /
/// `(async sequence[T])?` was SILENTLY ACCEPTED at a non-nullable
/// parameter of its own type. It is the fifth instance of the drift #3985 and
/// #3988 closed for channels, slices, arrays and reference-constrained type
/// parameters — but it took TWO fixes, not one, because the issue's premise
/// held for only one of the two shapes it named.
/// @remarks <b>Cause one — the predicate, exactly as the issue diagnosed it.</b>
/// `Conversion.IsReferenceLikeTarget` names every structural shape that
/// IS a reference type while an open element leaves its `ClrType` null,
/// and omitted `MapTypeSymbol`, `SequenceTypeSymbol` and
/// `AsyncSequenceTypeSymbol`. Since #3999 unified the three hand-copies of
/// that predicate, this one arm is the whole answer for the OPEN spelling: the
/// Kotlin-model null-safety gate that #3999 restored in
/// `OverloadResolver.CallBinding` asks
/// `IsNullableReferenceGateRejected`, which bottoms out here, and a shape
/// it does not recognise as a reference is a shape it declines to gate — so
/// the argument took the `ContainsTypeParameter` bypass and flowed through
/// unchecked.
///
/// <b>Cause two — and the issue's diagnosis was WRONG about it.</b> The
/// issue asserted that `map` and `sequence` "should report GS0154
/// exactly as their closed forms do". Measured on the parent commit that is
/// true of `map` and FALSE of `sequence`: `(sequence[int32])?`
/// at a `sequence[int32]` parameter compiled silently too, as did
/// `(async sequence[int32])?`, and so did a plain imported
/// `IEnumerable[int32]?` at an `IEnumerable[int32]` parameter — while
/// `string?`, `List[int32]?`, `Dictionary[string, int32]?` and
/// `map[string, int32]?` were all correctly rejected at their own
/// non-nullable forms. The second cause is issue #3093's identity-alias arm at
/// the top of `ClassifyCore`: its shape probe reaches a
/// `NullableTypeSymbol` through the `ClrType` relay (issue #1627's
/// leak) and `AreRuntimeEquivalentIgnoringReferenceNullability` then
/// answers `true` across the annotation by construction, so the arm
/// classified `S? -> S` as IDENTITY and returned before any
/// null-safety rule could run. The enumerable shapes were the only reference
/// types in the language exempt from Kotlin-model null safety.
///
/// <b>Why both halves are load-bearing.</b> Fixing only the predicate
/// would have INVERTED the asymmetry for sequences rather than removing it —
/// the open spelling rejected, the closed one still accepted — which is the
/// same defect the issue set out to forbid, pointing the other way. Fixing
/// only the alias arm leaves every open `map` untouched. Together they
/// give one answer for both spellings of all three kinds.
///
/// <b>Soundness.</b> This was not merely a missing message. Measured on
/// the parent commit, `caller[string, int32](nil)` forwarding a
/// `(map[K, V])?` to a `map[K, V]` parameter compiled with NO
/// diagnostic, IL-VERIFIED, and threw `NullReferenceException` at run
/// time; the `sequence` spelling did the same. The
/// `NilFlowsIntoTheNonNullableSlot` theory pins both. Note the parent's IL
/// was VALID — the bug is a type-system hole, not an emission one — so the
/// run-time throw, not `ilverify`, is the witness.
///
/// <b>What this deliberately does not reach.</b> A bare `nil`
/// LITERAL at an OPEN non-nullable parameter is still accepted, and that is
/// shape-independent and pre-existing: `takes[T](nil)` compiles for
/// `chan[T]`, `[]T`, `map[K, V]` and `sequence[T]` alike on
/// both sides of this change, because `nil`'s type is
/// `TypeSymbol.Null` rather than a `NullableTypeSymbol` and the
/// null-safety gate only inspects the latter. Separately,
/// `(map[K, V])?` at an open imported `IDictionary[K, V]` parameter
/// stays accepted because `map[K, V] -> IDictionary[K, V]` is not
/// classifiable at all while the key and value are open (`var d
/// IDictionary[K, V] = m` reports GS0155 with no `?` anywhere) — issue
/// #3982's erasure family, not a nullability one, and the gate correctly
/// declines to blame nullability where dropping the `?` could not
/// help. Third, `await for v in s` over a parameter declared
/// `async sequence[T]` with an OPEN element reports GS0134 ("expected an
/// `IAsyncEnumerable[T]`") on both sides of this change, while the closed
/// `async sequence[int32]` spelling iterates — a loop-binding defect this
/// change neither causes nor fixes (issue #4020), and the reason the async row
/// below consumes through an explicit `IAsyncEnumerable[T]`
/// parameter. The SYNCHRONOUS sibling is unaffected: `for v in s` over an
/// open `sequence[T]` parameter is what two of the accepted rows below
/// do.
///
/// <b>Discrimination (ADR-0154).</b> Nine rejection rows compiled with no
/// diagnostic at all on the parent commit and two more are labelled
/// `control-…` because they were already rejected there — those two are
/// what holds the change to its scope, showing that ordinary imported
/// references and `map`'s closed spelling were never the defect. Every
/// accepted row also compiled, ran and IL-verified on the parent: they are
/// carried to prove the fix took nothing away, above all LINQ flowing into a
/// `sequence[int32]` parameter, which is what the second half of this fix
/// touches in real code, and the async-sequence row that walks every path this
/// change newly routes that kind through.
open class Issue3997NullableMapAndSequenceAtNonNullableParameterTests {
    /// The rejected spellings report their diagnostic, name the offending
    /// nullable type, and never reach the emitter.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the case must report.
    /// @param expectedType A type spelling the diagnostic must name.
    @Theory
    @MemberData("RejectedCases")
    func ANullableEnumerableOrMapAtANonNullableParameter_IsRejected(
        name string,
        source string,
        expectedId string,
        expectedType string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3997_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.Contains(expectedType, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The accepted spellings compile, IL-verify, run, and print exactly what
    /// they claim.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func TheRemediesAndTheUntouchedArms_CompileVerifyAndRun(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3997_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
` + "$appLog"))
            IlVerifier.Verify(appPath, Array.Empty[string]())
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The soundness witness. On the parent commit both programs compiled with
    /// NO diagnostic, IL-VERIFIED, printed `before` and then threw
    /// `NullReferenceException` — a `nil` flowing into a non-nullable
    /// `map[K, V]` / `sequence[T]` slot with the compiler silent. The
    /// bug was never merely a missing message.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @InlineData("an-open-nullable-map", `package P
import System

func takes[K, V](m map[K, V]) int32 {
    return m.Count
}

func caller[K, V](m (map[K, V])?) int32 {
    return takes[K, V](m)
}

Console.WriteLine("before")
Console.WriteLine(caller[string, int32](nil))
Console.WriteLine("after")`)
    @InlineData("an-open-nullable-sequence", `package P
import System

func total[T](s sequence[T]) int32 {
    var n = 0
    for v in s {
        n = n + 1
    }

    return n
}

func caller[T](s (sequence[T])?) int32 {
    return total[T](s)
}

Console.WriteLine("before")
Console.WriteLine(caller[int32](nil))
Console.WriteLine("after")`)
    func NilFlowsIntoTheNonNullableSlot_AndIsNowACompileError(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3997_nil_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `': a ` + "\u0060" + `nil` + "\u0060" + ` reaching a non-nullable slot must be a compile error, not a
`) + "run-time NullReferenceException. Log:\n" + appLog)
            Assert.Contains("GS0154", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The rows that must be REJECTED. All but the two `control-…` rows
        /// compiled with NO diagnostic on the parent commit.
        /// @returns Name, source, the diagnostic id, and a type spelling it must name.
        func RejectedCases() sequence[[]object] {
            // The reported repro, map half: the substituted parameter still
            // mentions K and V, so the argument took the `ContainsTypeParameter`
            // bypass and `Conversion.Classify` was never asked.
            yield[]object{"the-reported-repro-a-nullable-open-map-at-an-open-map-parameter", `package P
import System

func takes[K, V](m map[K, V]) int32 {
    return m.Count
}

func caller[K, V](m (map[K, V])?) int32 {
    return takes[K, V](m)
}

Console.WriteLine("x")`, "GS0154", "map[K,V]?"}
            // The reported repro, sequence half.
            yield[]object{"the-reported-repro-a-nullable-open-sequence-at-an-open-sequence-parameter", `package P
import System

func takes[T](s sequence[T]) int32 {
    return 1
}

func caller[T](s (sequence[T])?) int32 {
    return takes[T](s)
}

Console.WriteLine("x")`, "GS0154", "sequence[T]?"}
            // `async sequence[T]` is a THIRD symbol kind the issue did not name.
            // `AsyncSequenceTypeSymbol.MakeClrType` produces `IAsyncEnumerable<T>`
            // and returns null on an open element for exactly the same reason.
            yield[]object{"a-nullable-open-async-sequence-at-an-open-async-sequence-parameter", `package P
import System

func takes[T](s async sequence[T]) int32 {
    return 1
}

func caller[T](s (async sequence[T])?) int32 {
    return takes[T](s)
}

Console.WriteLine("x")`, "GS0154", "sequence[T]?"}
            // The issue said the CLOSED sequence already reported GS0154. It did
            // not — this row is the correction, and it is the reason the fix has a
            // second half. `sequence[int32]`'s `ClrType` is a real
            // `IEnumerable<int32>`, so the predicate of cause one always answered
            // `true` here; the #3093 identity-alias arm returned IDENTITY before
            // any null-safety rule could run.
            yield[]object{"a-nullable-closed-sequence-at-a-closed-sequence-parameter", `package P
import System

func takes(s sequence[int32]) int32 {
    return 1
}

func caller(s (sequence[int32])?) int32 {
    return takes(s)
}

Console.WriteLine("x")`, "GS0154", "sequence[int32]?"}
            yield[]object{"a-nullable-closed-async-sequence-at-a-closed-async-sequence-parameter", `package P
import System

func takes(s async sequence[int32]) int32 {
    return 1
}

func caller(s (async sequence[int32])?) int32 {
    return takes(s)
}

Console.WriteLine("x")`, "GS0154", "sequence[int32]?"}
            // The same hole through the ASSIGNMENT door rather than the call door:
            // the alias arm is consulted by `Conversion.Classify` itself, so a
            // plain `var` declaration inherited it. Note the id is GS0155 here —
            // an initializer reports the conversion failure, not the parameter one.
            yield[]object{"a-nullable-closed-sequence-assigned-to-a-non-nullable-local", `package P
import System

func caller(src (sequence[int32])?) int32 {
    var s sequence[int32] = src
    return 1
}

Console.WriteLine("x")`, "GS0155", "sequence[int32]?"}
            // The alias arm matched ANY two enumerable shapes, so the G# alias and
            // the imported interface leaked into each other in both directions.
            yield[]object{"a-nullable-sequence-at-an-imported-enumerable-parameter", `package P
import System
import System.Collections.Generic

func takes(e IEnumerable[int32]) int32 {
    return 1
}

func caller(s (sequence[int32])?) int32 {
    return takes(s)
}

Console.WriteLine("x")`, "GS0154", "sequence[int32]?"}
            yield[]object{"a-nullable-imported-enumerable-at-a-sequence-parameter", `package P
import System
import System.Collections.Generic

func takes(s sequence[int32]) int32 {
    return 1
}

func caller(e IEnumerable[int32]?) int32 {
    return takes(e)
}

Console.WriteLine("x")`, "GS0154", "IEnumerable[int32]?"}
            // No G# structural shape anywhere: a plain imported `IEnumerable<T>?`
            // at its own non-nullable form was accepted on the parent commit, while
            // `List[int32]?` below was not. That is how far the alias arm reached,
            // and it is why this half of the fix is a language rule rather than a
            // `sequence` special case.
            yield[]object{"a-nullable-imported-enumerable-at-its-own-non-nullable-form", `package P
import System
import System.Collections.Generic

func takes(e IEnumerable[int32]) int32 {
    return 1
}

func caller(e IEnumerable[int32]?) int32 {
    return takes(e)
}

Console.WriteLine("x")`, "GS0154", "IEnumerable[int32]?"}
            // Rejected on the parent commit too: a CLOSED map's `ClrType` is a real
            // `Dictionary<string, int32>`, so cause one never applied to it and
            // there is no alias arm for a map. This row is the oracle the issue
            // reasoned from, and it is unchanged.
            yield[]object{"control-a-nullable-closed-map-at-a-closed-map-parameter", `package P
import System

func takes(m map[string, int32]) int32 {
    return m.Count
}

func caller(m (map[string, int32])?) int32 {
    return takes(m)
}

Console.WriteLine("x")`, "GS0154", "map[string,int32]?"}
            // Rejected on the parent commit too, and the row that proves the
            // enumerable shapes were the outlier rather than the model: an ordinary
            // imported reference type has always been gated.
            yield[]object{"control-a-nullable-imported-list-at-its-own-non-nullable-form", `package P
import System
import System.Collections.Generic

func takes(l List[int32]) int32 {
    return 1
}

func caller(l List[int32]?) int32 {
    return takes(l)
}

Console.WriteLine("x")`, "GS0154", "List[int32]?"}
        }

        /// The rows that must still COMPILE, IL-VERIFY and RUN. Every one of them
        /// did so on the parent commit as well: they assert that the two edits took
        /// nothing away.
        /// @returns Name, source, and the expected stdout lines in order.
        func AcceptedCases() sequence[[]object] {
            // `!!` is the first remedy the diagnostic names. The count is asserted
            // so a dropped or mis-substituted handle prints the wrong number rather
            // than merely compiling.
            yield[]object{"bang-bang-lets-an-open-nullable-map-reach-the-parameter", `package P
import System

func takes[K, V](m map[K, V]) int32 {
    return m.Count
}

func caller[K, V](m (map[K, V])?) int32 {
    return takes[K, V](m!!)
}

let d = map[string, int32]{}
d["a"] = 1
d["b"] = 2
Console.WriteLine(caller[string, int32](d))`, []string{"2"}}
            // A nullable-typed parameter is the second remedy: nothing is dropped,
            // so nothing is gated.
            yield[]object{"a-nullable-typed-parameter-still-accepts-an-open-nullable-map", `package P
import System

func takes[K, V](m (map[K, V])?) int32 {
    if m != nil {
        return m.Count
    }

    return -1
}

func caller[K, V](m (map[K, V])?) int32 {
    return takes[K, V](m)
}

let d = map[string, int32]{}
d["a"] = 1
Console.WriteLine(caller[string, int32](d))
Console.WriteLine(caller[string, int32](nil))`, []string{"1", "-1"}}
            // Condition narrowing over an OPEN map: inside the `!= nil` branch the
            // local is no longer nullable, so the gate has nothing to reject. This
            // is the remedy the diagnostic points at, and #3988 showed it is not
            // free — the fourth copy of the predicate had to be unified before the
            // structural shapes narrowed at all.
            yield[]object{"condition-narrowing-lifts-an-open-map-and-satisfies-the-parameter", `package P
import System

func takes[K, V](m map[K, V]) int32 {
    return m.Count
}

func caller[K, V](src (map[K, V])?) int32 {
    var m = src
    if m != nil {
        return takes[K, V](m)
    }

    return -1
}

let d = map[string, int32]{}
d["a"] = 1
d["b"] = 2
d["c"] = 3
Console.WriteLine(caller[string, int32](d))
Console.WriteLine(caller[string, int32](nil))`, []string{"3", "-1"}}
            // Assignment narrowing over an OPEN map — the other narrowing door.
            yield[]object{"assignment-narrowing-lifts-an-open-map-and-satisfies-the-parameter", `package P
import System

func takes[K, V](m map[K, V]) int32 {
    return m.Count
}

func caller[K, V](src map[K, V]) int32 {
    var m (map[K, V])? = nil
    m = src
    return takes[K, V](m)
}

let d = map[string, int32]{}
d["a"] = 1
Console.WriteLine(caller[string, int32](d))`, []string{"1"}}
            // Both narrowing doors again over an OPEN sequence, with the elements
            // actually enumerated so a wrong handle fails rather than compiles.
            yield[]object{"condition-narrowing-lifts-an-open-sequence-and-satisfies-the-parameter", `package P
import System

func total[T](s sequence[T]) int32 {
    var n = 0
    for v in s {
        n = n + 1
    }

    return n
}

func caller[T](src (sequence[T])?) int32 {
    var s = src
    if s != nil {
        return total[T](s)
    }

    return -1
}

Console.WriteLine(caller[int32]([]int32{1, 2, 3}))
Console.WriteLine(caller[int32](nil))`, []string{"3", "-1"}}
            yield[]object{"assignment-narrowing-lifts-an-open-sequence-and-satisfies-the-parameter", `package P
import System

func total[T](s sequence[T]) int32 {
    var n = 0
    for v in s {
        n = n + 1
    }

    return n
}

func caller[T](src sequence[T]) int32 {
    var s (sequence[T])? = nil
    s = src
    return total[T](s)
}

Console.WriteLine(caller[int32]([]int32{1, 2, 3, 4}))`, []string{"4"}}
            // The #3093 identity alias in the directions the fix leaves alone: a
            // bare `sequence[int32]` and a `(sequence[int32])?` both reach an
            // `IEnumerable[int32]?` slot, because ADDING or PRESERVING the
            // annotation drops nothing. Only the dropping direction is restricted.
            yield[]object{"the-sequence-alias-still-reaches-a-nullable-enumerable-slot", `package P
import System
import System.Collections.Generic

func takesNullableEnum(e IEnumerable[int32]?) int32 {
    if e == nil {
        return -1
    }

    var n = 0
    for v in e {
        n = n + 1
    }

    return n
}

func fromBare(s sequence[int32]) int32 {
    return takesNullableEnum(s)
}

func fromNullable(s (sequence[int32])?) int32 {
    return takesNullableEnum(s)
}

Console.WriteLine(fromBare([]int32{1, 2}))
Console.WriteLine(fromNullable([]int32{1, 2, 3}))
Console.WriteLine(fromNullable(nil))`, []string{"2", "3", "-1"}}
            // The non-nullable alias identity itself (issue #3093), both
            // directions, unchanged: 2 elements through the sequence parameter plus
            // 2 x 10 through the enumerable one.
            yield[]object{"the-sequence-alias-identity-still-holds-in-both-directions", `package P
import System
import System.Collections.Generic

func takesSeq(s sequence[int32]) int32 {
    var n = 0
    for v in s {
        n = n + 1
    }

    return n
}

func takesEnum(e IEnumerable[int32]) int32 {
    var n = 0
    for v in e {
        n = n + 10
    }

    return n
}

func caller(s sequence[int32], e IEnumerable[int32]) int32 {
    return takesSeq(e) + takesEnum(s)
}

let xs = []int32{1, 2}
Console.WriteLine(caller(xs, xs))`, []string{"22"}}
            // LINQ is what actually flows through the alias arm in real code, so it
            // is asserted directly: a nullability-annotated BCL result must still
            // arrive non-nullable at a `sequence[int32]` parameter.
            yield[]object{"a-linq-result-still-reaches-a-non-nullable-sequence-parameter", `package P
import System
import System.Linq

func total(s sequence[int32]) int32 {
    var n = 0
    for v in s {
        n = n + v
    }

    return n
}

let nums = Enumerable.Range(1, 4)
Console.WriteLine(total(nums))
Console.WriteLine(total(nums.Where(func(v int32) bool { return v > 2 })))`, []string{"10", "7"}}
            // The ADR-0159 slice -> sequence projection is a different arm and must
            // not have been disturbed by either edit.
            yield[]object{"the-slice-to-sequence-projection-is-untouched", `package P
import System

func total[T](s sequence[T]) int32 {
    var n = 0
    for v in s {
        n = n + 1
    }

    return n
}

func caller[T](xs []T) int32 {
    return total[T](xs)
}

Console.WriteLine(caller[int32]([]int32{1, 2, 3, 4, 5}))`, []string{"5"}}
            // `== nil` / `!= nil` on a NULLABLE open map and sequence: naming both
            // kinds in `IsReferenceLikeTarget` also routes the emitter's
            // nil-comparison path (`MethodBodyEmitter.Conversions`) through the
            // reference arm for the open spelling, so the answers are asserted
            // rather than assumed.
            yield[]object{"nil-comparison-over-an-open-nullable-map-and-sequence", `package P
import System

func mapIsNil[K, V](m (map[K, V])?) bool {
    return m == nil
}

func seqIsNotNil[T](s (sequence[T])?) bool {
    return s != nil
}

let d = map[string, int32]{}
Console.WriteLine(mapIsNil[string, int32](nil))
Console.WriteLine(mapIsNil[string, int32](d))
Console.WriteLine(seqIsNotNil[int32]([]int32{1}))
Console.WriteLine(seqIsNotNil[int32](nil))`, []string{"True", "False", "True", "False"}}
            // The same comparison on a BARE (non-`?`) open slot, which is where the
            // predicate change could most plausibly have altered emission.
            yield[]object{"nil-comparison-over-a-bare-open-map-and-sequence", `package P
import System

func mapCount[K, V](m map[K, V]) int32 {
    if m == nil {
        return -1
    }

    return m.Count
}

func seqCount[T](s sequence[T]) int32 {
    if s == nil {
        return -1
    }

    var n = 0
    for v in s {
        n = n + 1
    }

    return n
}

let d = map[string, int32]{}
d["a"] = 1
Console.WriteLine(mapCount[string, int32](d))
Console.WriteLine(seqCount[int32]([]int32{1, 2, 3}))`, []string{"1", "3"}}
            // Review finding (Copilot on PR #4017): `AsyncSequenceTypeSymbol` is
            // the symbol kind the issue did not name and this PR added on its own
            // judgement, so nothing outside this file covers it — and it is now
            // routed through EVERY `IsReferenceLikeTarget` consumer, not only the
            // overload gate. Rejection rows alone prove the gate fires without
            // proving the accepted paths still emit correctly. This row walks the
            // newly routed ones over an OPEN async sequence and asserts the
            // program's own output at each: the `T -> T?` reference wrap
            // (`var s (async sequence[T])? = nil`), assignment narrowing (`s =
            // src`), condition narrowing (`if s != nil`), `!!`, the lifted
            // `T? -> U?` arm (an `(async sequence[T])?` at an
            // `IAsyncEnumerable[T]?` parameter), and the emitter's nil-comparison
            // path on a nullable open slot. Every value is produced by actually
            // enumerating the async iterator, so a wrong representation prints the
            // wrong number rather than merely compiling — and, like every other
            // accepted row here, it compiled, ran and IL-verified on the parent
            // too: its job is to keep those paths from regressing, not to turn red.
            yield[]object{"an-open-async-sequence-through-every-newly-routed-path", `package P
import System
import System.Collections.Generic

async func numbers() async sequence[int32] {
    yield 1
    yield 2
    yield 3
}

async func count[T](s IAsyncEnumerable[T]) int32 {
    var n = 0
    await for v in s {
        n = n + 1
    }

    return n
}

async func countNullable[T](s IAsyncEnumerable[T]?) int32 {
    if s == nil {
        return -1
    }

    var n = 0
    await for v in s {
        n = n + 1
    }

    return n
}

async func narrowed[T](src (async sequence[T])?) int32 {
    var s = src
    if s != nil {
        return await count[T](s)
    }

    return -1
}

async func wrapped[T](src async sequence[T]) int32 {
    var s (async sequence[T])? = nil
    s = src
    return await count[T](s)
}

async func forgiven[T](src (async sequence[T])?) int32 {
    return await count[T](src!!)
}

async func lifted[T](src (async sequence[T])?) int32 {
    return await countNullable[T](src)
}

func isNil[T](s (async sequence[T])?) bool {
    return s == nil
}

async func run() {
    Console.WriteLine(await narrowed[int32](numbers()))
    Console.WriteLine(await narrowed[int32](nil))
    Console.WriteLine(await wrapped[int32](numbers()))
    Console.WriteLine(await forgiven[int32](numbers()))
    Console.WriteLine(await lifted[int32](numbers()))
    Console.WriteLine(await lifted[int32](nil))
    Console.WriteLine(isNil[int32](nil))
    Console.WriteLine(isNil[int32](numbers()))
}

run().Wait()`, []string{"3", "-1", "3", "3", "3", "-1", "True", "False"}}
            // The issue asked for each behaviour at an open AND a closed
            // instantiation. The closed map is the one shape whose `ClrType`
            // already answered `true` before this change, so narrowing and the
            // `T -> T?` wrap over it must be bit-for-bit unaffected.
            yield[]object{"narrowing-and-the-nullable-wrap-over-a-closed-map-are-unaffected", `package P
import System

func takes(m map[string, int32]) int32 {
    return m.Count
}

func narrowed(src (map[string, int32])?) int32 {
    var m = src
    if m != nil {
        return takes(m)
    }

    return -1
}

func wrapped(src map[string, int32]) bool {
    var m (map[string, int32])? = src
    return m == nil
}

let d = map[string, int32]{}
d["a"] = 1
d["b"] = 2
Console.WriteLine(narrowed(d))
Console.WriteLine(narrowed(nil))
Console.WriteLine(wrapped(d))`, []string{"2", "-1", "False"}}
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
