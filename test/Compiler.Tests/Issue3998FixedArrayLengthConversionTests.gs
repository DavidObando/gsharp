// <copyright file="Issue3998FixedArrayLengthConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3998: a fixed-length array's declared LENGTH was not part of any
/// conversion, so `[3]int32` converted implicitly to `[4]int32`, and
/// `[]int32` converted implicitly to `[3]int32` — at the TOP level,
/// with no reflection, erasure or generic instantiation involved.
/// @remarks <b>Where the length was lost.</b> `ArrayTypeSymbol` is backed by
/// the plain SZ-array `T[]` — the SAME `System.Type` as the slice
/// `[]T` and as an array of every other length. Two identity helpers
/// (`TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability` and
/// `Conversion.TryClassifyWrappedElementIdentity`) DO compare the length,
/// but neither ever rejects: they only decline to answer "identity", and the
/// pair then fell through to the general CLR reference-assignability arm
/// (issue #521), where `int32[]` is assignable from `int32[]`. The
/// #2516 invariance guard that stops CLR array covariance fired only when the
/// SOURCE was a `SliceTypeSymbol` or an `ImportedTypeSymbol(T[])`;
/// `from is ArrayTypeSymbol` was not guarded at all. In the other
/// direction the #528 and #1162 slice-source arms accepted any
/// `ArrayTypeSymbol` target, because a `[3]int32` target's
/// `ClrType` is the very `int32[]` they were matching.
///
/// <b>The rule this file pins.</b> A fixed array's length is part of its
/// type. `[N]T` converts IMPLICITLY to `[]T` — dropping a known
/// length for an unknown one is a widening and a representation no-op, so a
/// fixed array still reaches every `[]T` slot. Nothing converts
/// implicitly INTO a `[N]T` except a `[N]T` of the same length.
/// Every rejected pair keeps its explicit `cast[…]`, exactly as slice
/// covariance does (`GS0156` points at it); the cast reinterprets and
/// does not change the value, so a `[3]int32` cast to `[4]int32`
/// still reports `.Length == 3`.
///
/// <b>Two side effects of the same arm, measured rather than
/// asserted.</b> A fixed array whose element is a SAME-COMPILATION type used
/// to fail to widen at all (`[2]Foo -> []Foo` reported
/// `GS0154`/`GS0156`), because the widening path existed only for an
/// element with a CLR type; the new arm compares elements symbolically and
/// closes that. And a COVARIANT element used to report `GS0155` — no
/// conversion at all, so `cast[[]Base](d)` did not compile either — and
/// now reports `GS0156` with a working cast, matching what
/// `[]Derived -> []Base` has had since #2516. Element invariance for
/// IMPLICIT conversions is unchanged in both cases.
///
/// <b>The line the fix does not cross.</b> An array recovered from
/// METADATA arrives as `ImportedTypeSymbol(T[])` and carries no length —
/// reflection never recorded one. Rejecting such a pair would break ordinary
/// interop, so the guard deliberately does not fire for an imported SZ-array
/// on either side. That is the same line #3924's
/// `IsMetadataRecoveredElement` and #3962's `interop-*` cases draw,
/// and the `interop-*` cases here draw it again.
///
/// <b>Known residue at the time, since narrowed (#4012).</b> This PR
/// left the MEMBER surface of a generic over a fixed array reflecting the
/// length-free CLR shape: `List[[3]int32]` keeps `[3]int32` in its
/// symbolic `TypeArguments` (#3962 retained it), but `Add`'s
/// parameter was read off the closed `List<int32[]>` rather than
/// projected through that argument, so `xs.Add([4]int32{…})` was
/// accepted. #4012 has closed that — by widening the inline gates of
/// `ConversionClassifier.TrySubstituteParameterTypeFromReceiver`, and by
/// giving `[N]T` the erased-argument ride-through `[]T` already had
/// — and the two rows that pinned it are kept, flipped, in
/// (cref:FlippedByIssue4012Cases). The measurement recorded here still
/// stands and is worth keeping: widening
/// `ImportedTypeSymbol.HasSubstitutableTypeArgument` to include
/// `ContainsFixedLengthArray` — the mechanism #4002's hand-off predicted
/// — changed NEITHER row, because the imported instance-call path does not
/// consult that property for parameter types.
///
/// <b>The last residue, since closed (#4024).</b> A SLICE type argument
/// was erased to `T[]` by `Binder.ProjectGenericArgument` before any
/// comparison could see it, so `List[[]int32]` converted to
/// `List[[3]int32]`. #3962 and #4012 both declined it because retaining a
/// slice symbolically changes the representation of every `List[[]T]` in
/// the corpus and bypasses the #1354 nullable-flags path. #4024 did it anyway,
/// having measured both: the corpus diagnostic output is byte-identical (a
/// retained `[]T` still fails every arm of
/// `ImportedTypeSymbol.HasSubstitutableTypeArgument`, so no member
/// projection moves), and the nullable-flags concern is empty, because an
/// ANNOTATED slice (`[]string?`) was already retained through
/// `RequiresSymbolicProjection` and never reached that branch — so the
/// arguments newly diverted off it are precisely the ones with no annotation
/// to lose. The
/// row that pinned this is kept, flipped, in
/// (cref:FlippedByIssue4024Cases), and the residue is now empty.
open class Issue3998FixedArrayLengthConversionTests {
    /// A length mismatch is a different type and never reaches the emitter.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    @MemberData("FlippedByIssue4012Cases")
    @MemberData("FlippedByIssue4024Cases")
    func ADifferentArrayShape_DoesNotConvertImplicitly(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3998_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every accepting case compiles, IL-verifies, runs, and prints what it
    /// claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func ALegitimateArrayConversion_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3998_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
` + "$appLog"))
            IlVerifier.Verify(appPath)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(expectedLines, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// An array that came back through reflection has no length to disagree
    /// with, so it keeps converting either way.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("InteropCases")
    func AMetadataRecoveredArray_StaysLenient(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3998_interop_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(expectedLines, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library the interop cases link against. A genuine CLR
        /// `int[]` has no length in metadata, which is the whole point.
        private const LibrarySource string = (`namespace Interop;

public static class ArrayProbes
{
    // A genuine ` + "`" + `int[]` + "`" + ` parameter: the CLR type a G# ` + "`" + `[3]int32` + "`" + `
    // really has. A fixed array must keep reaching it.
    public static int Count(int[] items) => items.Length;

    // A genuine ` + "`" + `int[]` + "`" + ` return: metadata records no length at all, so
    // the comparison against a ` + "`" + `[3]int32` + "`" + ` slot must stay lenient
    // rather than reject on information nobody has.
    public static int[] Make() => new[] { 10, 20, 30 };
}`)

        /// Pairs that must NO LONGER convert implicitly. Each is measured on
        /// `main` as an accepted program.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func RejectedCases() sequence[[]object] {
            // Sub-case 1, the core of the issue: two declared lengths are two
            // types. Nothing here involves reflection, erasure, or a generic.
            yield[]object{"a-shorter-fixed-array-does-not-fill-a-longer-slot", `package P
import System

func main2() {
    var a3 [3]int32 = [3]int32{1, 2, 3}
    var a4 [4]int32 = a3
    Console.WriteLine(a4.Length.ToString())
}

main2()`, "Cannot convert type '[3]int32' to '[4]int32'"}
            // The same rule at a G#-DECLARED parameter. This is the row #4002's
            // hand-off named: it owes nothing to reflection, so it is the honest
            // statement of the bare rule.
            yield[]object{"a-declared-fixed-array-parameter-rejects-another-length", `package P
import System

func take3(a [3]int32) int32 {
    return a[0]
}

func main2() {
    Console.WriteLine(take3([4]int32{1, 2, 3, 4}).ToString())
}

main2()`, "requires a value of type '[3]int32' but was given a value of type '[4]int32'"}
            // The return position takes the same rule as assignment.
            yield[]object{"a-fixed-array-return-rejects-another-length", `package P
import System

func returns3() [3]int32 {
    return [4]int32{1, 2, 3, 4}
}

func main2() {
    Console.WriteLine(returns3().Length.ToString())
}

main2()`, "Cannot convert type '[4]int32' to '[3]int32'"}
            // Sub-case 2 (bare half): a slice's length is unknown, so it cannot
            // silently satisfy a slot that declares one.
            yield[]object{"a-slice-does-not-implicitly-narrow-to-a-fixed-length", `package P
import System

func main2() {
    var s []int32 = []int32{1, 2, 3}
    var back [3]int32 = s
    Console.WriteLine(back.Length.ToString())
}

main2()`, "Cannot convert type '[]int32' to '[3]int32'"}
            // Sub-case 3: the literal's own length against the declared slot.
            // This is not a separate rule — the literal binds as `[2]int32`
            // (ExpressionBinder.Literals builds `ArrayTypeSymbol.Get(element,
            // length)` from the WRITTEN length, never from the target) and then
            // takes sub-case 1's conversion. It was accepted with `lit.Length`
            // reporting 2 under a type that said 3.
            yield[]object{"a-literal-of-the-wrong-length-does-not-fill-a-declared-slot", `package P
import System

func main2() {
    var lit [3]int32 = [2]int32{1, 2}
    Console.WriteLine(lit.Length.ToString())
}

main2()`, "Cannot convert type '[2]int32' to '[3]int32'"}
            // The same literal mismatch through a struct field initializer, so
            // the rule is a property of the conversion and not of `var`.
            yield[]object{"a-fixed-array-field-rejects-a-literal-of-another-length", `package P
import System

struct Holder {
    var Slot [3]int32
}

func main2() {
    var h = Holder{Slot: [2]int32{1, 2}}
    Console.WriteLine(h.Slot.Length.ToString())
}

main2()`, "Cannot convert type '[2]int32' to '[3]int32'"}
            // A same-compilation element type reaches the symbolic arm (#1162)
            // rather than the CLR-backed one, and takes the same rule.
            yield[]object{"a-slice-of-a-same-compilation-element-does-not-narrow", `package P
import System

struct Foo {
    var X int32
}

func main2() {
    var s []Foo = []Foo{Foo{X: 1}, Foo{X: 2}}
    var fixed2 [2]Foo = s
    Console.WriteLine(fixed2.Length.ToString())
}

main2()`, "Cannot convert type '[]Foo' to '[2]Foo'"}
            // Not a length row, but the same arm decides it, so it is measured
            // here rather than left to a reviewer to infer from the diff. A fixed
            // array's ELEMENT stays invariant for IMPLICIT conversions, exactly as
            // before — but the disposition of the rejection changed, in the
            // LOOSENING direction: a covariant element used to report `GS0155`
            // (no conversion at all, so `cast[[]Base](d)` did not compile
            // either), and now reports `GS0156` with a working cast, which is
            // what `[]Derived -> []Base` has had since #2516. The
            // `the-explicit-cast-covers-symbolic-and-covariant-elements-too`
            // case below is the other half of this pair; both were red before
            // the fix, for opposite reasons.
            yield[]object{"a-covariant-element-is-explicit-only-not-implicit", `package P
import System

open class Base {
}

class Derived : Base {
}

func main2() {
    var d = [2]Derived{Derived(), Derived()}
    var b []Base = d
    Console.WriteLine(b.Length.ToString())
}

main2()`, "Cannot convert type '[2]Derived' to '[]Base'. An explicit conversion exists"}
            yield[]object{"a-covariant-element-is-explicit-only-at-a-matching-length", `package P
import System

open class Base {
}

class Derived : Base {
}

func main2() {
    var d = [2]Derived{Derived(), Derived()}
    var c [2]Base = d
    Console.WriteLine(c.Length.ToString())
}

main2()`, "Cannot convert type '[2]Derived' to '[2]Base'. An explicit conversion exists"}
            // A nullable annotation on the target does not smuggle the narrowing
            // back in: `[3]?int32` is a nullable REFERENCE to a length-3 array,
            // and nullable lifting peels the annotation before classification, so
            // the slice still meets the same rule.
            yield[]object{"a-nullable-fixed-array-target-does-not-accept-a-slice", `package P
import System

func main2() {
    var s []int32 = []int32{1, 2, 3}
    var x [3]?int32 = s
    Console.WriteLine(x!!.Length.ToString())
}

main2()`, "Cannot convert type '[]int32' to '[3]?int32'"}
            // Review finding 1 (#4018). Two nested types may share a simple name
            // when their containers differ (spec, "dotted qualifier"), and both
            // have a null `ClrType` while binding. The first cut of this fix gated
            // its element check on `AreTypeArgumentsEquivalent`, which falls back
            // to symbol kind plus simple NAME for exactly that pair — so
            // `[1]A.Item` became implicitly assignable to `[1]B.Item` and to
            // `[]B.Item`, and the compiled program threw
            // `NullReferenceException` reading `B.Item`'s field off an `A.Item`
            // value. `main` rejected all three; the regression was this PR's own,
            // and it is the same class of bug the PR exists to remove, one level
            // down. The gate now uses `IsCrossContextIdenticalElement`, which
            // compares user types by `Definition`.
            yield[]object{"a-homonym-element-is-not-the-same-element-at-a-matching-length", `package P
import System

struct A {
    struct Item {
        var X int32
    }
}

struct B {
    struct Item {
        var Y string
    }
}

func main2() {
    var ai = [1]A.Item{A.Item{X: 7}}
    var bi [1]B.Item = ai
    Console.WriteLine(bi[0].Y)
}

main2()`, "Cannot convert type '[1]A.Item' to '[1]B.Item'"}
            yield[]object{"a-homonym-element-does-not-widen-to-another-containers-slice", `package P
import System

struct A {
    struct Item {
        var X int32
    }
}

struct B {
    struct Item {
        var Y string
    }
}

func main2() {
    var ai = [1]A.Item{A.Item{X: 7}}
    var bs []B.Item = ai
    Console.WriteLine(bs.Length.ToString())
}

main2()`, "Cannot convert type '[1]A.Item' to '[]B.Item'"}
            yield[]object{"a-homonym-element-does-not-satisfy-a-declared-parameter", `package P
import System

struct A {
    struct Item {
        var X int32
    }
}

struct B {
    struct Item {
        var Y string
    }
}

func takesB(a [1]B.Item) string {
    return a[0].Y
}

func main2() {
    var ai = [1]A.Item{A.Item{X: 7}}
    Console.WriteLine(takesB(ai))
}

main2()`, "requires a value of type '[1]B.Item' but was given a value of type '[1]A.Item'"}
        }

        /// Everything that must KEEP working: the widening direction, the whole
        /// surrounding array surface, and the explicit escape hatch. A fix that
        /// only stopped accepting things would pass the rejection theory and fail
        /// every one of these.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // `[N]T -> []T` is the direction that stays implicit, and the reason
            // the rule is stated as widening rather than as "the shapes must
            // match": rejecting it would strand every fixed array in front of
            // every `[]T` parameter with no escape but a cast.
            yield[]object{"a-fixed-array-still-widens-to-a-slice", `package P
import System

func takesSlice(s []int32) int32 {
    return s.Length
}

func returnsSlice() []int32 {
    return [3]int32{1, 2, 3}
}

func main2() {
    var a3 = [3]int32{1, 2, 3}
    var s []int32 = a3
    Console.WriteLine(s.Length.ToString())
    Console.WriteLine(takesSlice(a3).ToString())
    Console.WriteLine(returnsSlice().Length.ToString())
}

main2()`, []string{"3", "3", "3"}}
            // The same widening with a same-compilation element, which takes the
            // symbolic arm rather than the CLR-backed one. This row was RED before
            // the fix and is red for the opposite reason: the widening path
            // existed only for an element with a CLR type, so `[2]Foo -> []Foo`
            // reported GS0154/GS0156 while `[2]int32 -> []int32` was implicit.
            // The new arm compares elements symbolically and closes that too.
            yield[]object{"a-fixed-array-of-a-same-compilation-element-still-widens", `package P
import System

struct Foo {
    var X int32
}

func takesFooSlice(s []Foo) int32 {
    return s.Length
}

func main2() {
    var fa = [2]Foo{Foo{X: 1}, Foo{X: 2}}
    Console.WriteLine(takesFooSlice(fa).ToString())
    var s []Foo = fa
    Console.WriteLine(s[1].X.ToString())
}

main2()`, []string{"2", "2"}}
            // The rest of a fixed array's conversion surface is element-based,
            // not shape-based, and the new guard must not intercept any of it:
            // `System.Array`, the array interfaces, `object`, and `for … in`.
            yield[]object{"the-surrounding-array-surface-is-untouched", `package P
import System
import System.Collections.Generic
import System.Linq

func takesArrayBase(a Array) int32 {
    return a.Length
}

func takesSeq(e IEnumerable[int32]) int32 {
    return e.Count()
}

func takesObject(o object) string {
    return o.GetType().Name
}

func main2() {
    var a3 = [3]int32{1, 2, 3}
    Console.WriteLine(takesArrayBase(a3).ToString())
    Console.WriteLine(takesSeq(a3).ToString())
    Console.WriteLine(takesObject(a3))
    var total = 0
    for v in a3 {
        total = total + v
    }

    Console.WriteLine(total.ToString())
}

main2()`, []string{"3", "3", "Int32[]", "6"}}
            // A matching length is still one type, in both spellings, and a
            // generic over a fixed array still round-trips through its members.
            yield[]object{"a-matching-length-is-still-one-type", `package P
import System
import System.Collections.Generic

func take3(a [3]int32) int32 {
    return a[0]
}

func main2() {
    var a3 = [3]int32{1, 2, 3}
    var same [3]int32 = a3
    Console.WriteLine(same.Length.ToString())
    Console.WriteLine(take3([3]int32{9, 8, 7}).ToString())

    var xs = List[[3]int32]()
    xs.Add([3]int32{4, 5, 6})
    Console.WriteLine(xs[0].Length.ToString())
}

main2()`, []string{"3", "9", "3"}}
            // GS0156 promises a cast, so the cast has to exist and verify. It
            // reinterprets rather than converts: the value keeps its own length,
            // which is exactly why the IMPLICIT conversion is the thing withdrawn.
            yield[]object{"the-explicit-cast-escape-hatch-still-works-both-ways", `package P
import System

func main2() {
    var s []int32 = []int32{1, 2, 3}
    var narrowed = cast[[3]int32](s)
    Console.WriteLine(narrowed.Length.ToString())

    var a3 = [3]int32{1, 2, 3}
    var widened = cast[[4]int32](a3)
    Console.WriteLine(widened.Length.ToString())
}

main2()`, []string{"3", "3"}}
            // The cast promise has to hold for the symbolic (null-`ClrType`)
            // element and for the covariant element too, or the spec sentence
            // overclaims for exactly the cases the new arm added.
            yield[]object{"the-explicit-cast-covers-symbolic-and-covariant-elements-too", `package P
import System

open class Base {
}

class Derived : Base {
}

struct Foo {
    var X int32
}

func main2() {
    var d = [2]Derived{Derived(), Derived()}
    Console.WriteLine(cast[[]Base](d).Length.ToString())
    Console.WriteLine(cast[[2]Base](d).Length.ToString())

    var s []Foo = []Foo{Foo{X: 1}, Foo{X: 2}}
    Console.WriteLine(cast[[2]Foo](s).Length.ToString())
}

main2()`, []string{"2", "2", "2"}}
            // Review finding 2 (#4018): the cast the diagnostic and the spec
            // promise has to exist for a SAME-COMPILATION element too, and it
            // has to reach the emitter. `[3]Foo` and `[4]Foo` both have a null
            // `ClrType` while binding, so the CLR-keyed predicates could not see
            // that they share one runtime representation: the pair classified as
            // `None`, and once the binder was taught to answer from the symbols
            // the emitter had no arm either and raised `GS9998`. Both halves are
            // fixed, and the row asserts the point of the cast — it reinterprets
            // and does not change the value, so `.Length` is still 3.
            yield[]object{"the-explicit-cast-works-for-a-same-compilation-element-across-lengths", `package P
import System

struct Foo {
    var X int32
}

func main2() {
    var a3 = [3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}
    var a4 = cast[[4]Foo](a3)
    Console.WriteLine(a4.Length.ToString())
    Console.WriteLine(a4[2].X.ToString())

    var s []Foo = []Foo{Foo{X: 9}}
    Console.WriteLine(cast[[1]Foo](s)[0].X.ToString())
}

main2()`, []string{"3", "3", "9"}}
            // Slices are not collateral damage: slice-to-slice, slice literals,
            // and the growable `List[T]` shape are all unaffected.
            yield[]object{"ordinary-slice-conversions-are-unaffected", `package P
import System
import System.Collections.Generic

func takesSlice(s []int32) int32 {
    return s.Length
}

func main2() {
    var sl = []int32{7, 8}
    var sl2 []int32 = sl
    Console.WriteLine(sl2.Length.ToString())
    Console.WriteLine(takesSlice(sl).ToString())

    var grown = List[int32]()
    for v in sl {
        grown.Add(v)
    }

    Console.WriteLine(grown.Count.ToString())

    var jagged = [][]int32{ []int32{1, 2}, []int32{3} }
    Console.WriteLine(jagged[0].Length.ToString())
}

main2()`, []string{"2", "2", "2", "2"}}
        }

        /// The last row this file pinned as ACCEPTED residue, which #4024 turned
        /// into an error. Kept here, flipped rather than deleted, so the change
        /// reads as deliberate.
        /// @remarks This method used to be `ResidueCases` — "behaviour this PR
        /// deliberately does NOT change". Two of its three rows were the MEMBER
        /// slot read off the erased
        /// `List<int32[]>`/`Stack<int32[]>` rather than
        /// projected through the receiver's retained `[3]int32`; #4012 closed
        /// that gap and they moved, flipped, to
        /// (cref:FlippedByIssue4012Cases). The third was the SLICE
        /// type-argument erasure, a different mechanism, which #4024 has now
        /// closed — so the residue is empty and the method is a flipped block like
        /// its sibling.
        ///
        /// #4024's fix: `TypeSymbol.ContainsSourceArrayShape` retains
        /// BOTH G# array spellings at the four #3962 retention gates, so a
        /// source-spelled `List[[]int32]` is finally distinguishable from a
        /// metadata-recovered `List<int[]>` and therefore comparable
        /// against a retained `List[[3]int32]` at all. The #2735 guard in
        /// `Conversion.ClassifyCore` also had to stop reading `from`
        /// alone — with slices retained the pair can be asymmetric, and the
        /// reported direction had nothing length-bearing on the `from`
        /// side.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func FlippedByIssue4024Cases() sequence[[]object] {
            yield[]object{"a-slice-type-argument-no-longer-reaches-a-fixed-array-generic", `package P
import System
import System.Collections.Generic

func main2() {
    var slice = List[[]int32]()
    slice.Add([]int32{1, 2, 3})
    var fixed3 List[[3]int32] = slice
    Console.WriteLine(fixed3.Count.ToString())
}

main2()`, "Cannot convert type 'System.Collections.Generic.List[[]int32]' to 'System.Collections.Generic.List[[3]int32]'"}
        }

        /// The rows this file pinned as ACCEPTED residue and #4012 turned into
        /// errors. Kept here, flipped rather than deleted, so the change reads as
        /// deliberate.
        /// @remarks #4012 widened the entry and exit gates of
        /// `ConversionClassifier.TrySubstituteParameterTypeFromReceiver` to
        /// admit a `TypeSymbol.ContainsFixedLengthArray` type argument, so a
        /// generic's member slot is now projected through the `[3]int32` the
        /// receiver retained rather than read off the erased
        /// `List<int32[]>`. Note what did NOT close it: widening
        /// `ImportedTypeSymbol.HasSubstitutableTypeArgument`, which #3998
        /// measured and recorded here as changing nothing. That record was
        /// correct; the deciding gate is a different one.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func FlippedByIssue4012Cases() sequence[[]object] {
            yield[]object{"a-generic-members-parameter-follows-the-projected-array", `package P
import System
import System.Collections.Generic

func main2() {
    var xs = List[[3]int32]()
    xs.Add([4]int32{5, 6, 7, 8})
    Console.WriteLine(xs.Count.ToString())
    Console.WriteLine(xs[0].Length.ToString())
}

main2()`, "Cannot convert type '[4]int32' to '[3]int32'"}
            // `List[T]` also exposes the non-generic `IList.Add(object)`, which
            // would accept anything at all, so the row above is not proof on its
            // own. `Stack[T].Push(T)` has no such sibling: this is the member
            // projection by itself.
            yield[]object{"a-member-with-no-object-overload-rejects-another-length", `package P
import System
import System.Collections.Generic

func main2() {
    var st = Stack[[3]int32]()
    st.Push([4]int32{1, 2, 3, 4})
    Console.WriteLine(st.Count.ToString())
    Console.WriteLine(st.Peek().Length.ToString())
}

main2()`, "Cannot convert type '[4]int32' to '[3]int32'"}
        }

        /// The metadata-recovery line: a CLR `int[]` carries no length, so it
        /// keeps converting in both directions.
        /// @returns Name, G# source, expected stdout lines.
        func InteropCases() sequence[[]object] {
            yield[]object{"interop-a-fixed-array-still-reaches-a-clr-array-parameter", `package P
import System
import Interop

func main2() {
    Console.WriteLine(ArrayProbes.Count([3]int32{1, 2, 3}).ToString())
    Console.WriteLine(ArrayProbes.Count([5]int32{1, 2, 3, 4, 5}).ToString())
}

main2()`, []string{"3", "5"}}
            yield[]object{"interop-a-clr-array-return-still-fills-a-fixed-array-slot", `package P
import System
import Interop

func main2() {
    var a [3]int32 = ArrayProbes.Make()
    Console.WriteLine(a.Length.ToString())
    var s []int32 = ArrayProbes.Make()
    Console.WriteLine(s.Length.ToString())
}

main2()`, []string{"3", "3"}}
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Interop",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "Interop.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
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
