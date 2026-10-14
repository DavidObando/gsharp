// <copyright file="Issue3962GenericOverFixedArrayIdentityTests.cs" company="GSharp">
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

/// Issue #3962: a constructed generic over a fixed-length-array type argument
/// lost the length, so `List[[3]int32]` and `List[[4]int32]` were the
/// SAME type and converted to one another silently.
/// @remarks <b>Where it actually was.</b> Not in `Conversion`. By the time any
/// conversion ran there were no two symbols left to compare: the type-clause
/// binder (`Binder.ProjectGenericArgument`) and the construction binder
/// (`ExpressionBinder.TryResolveClrConstructionTypeArgs`) retain a
/// SYMBOLIC type argument only when the argument's CLR type is ABSENT (an
/// in-scope type parameter, a same-compilation user type) or a projection (a
/// named tuple). A fixed array HAS a closed CLR type — but `[N]T`,
/// `[]T` and every other length are all backed by the one SZ-array
/// `T[]`, so both spellings resolved to the single cached
/// `ImportedTypeSymbol` for `List<System.Int32[]>` and the
/// length was gone before classification began.
///
/// <b>Not IL-unsoundness.</b> `List<int32[]>` is one CLR type;
/// the pre-fix program IL-verified and ran. This is a type-IDENTITY precision
/// bug — two types the author spelled differently bound to one symbol — which
/// is why every accepting case below also runs and asserts its own stdout
/// rather than merely verifying.
///
/// <b>The line the fix must not cross.</b> An array recovered from
/// METADATA arrives as `ImportedTypeSymbol(T[])` and its length is gone
/// beyond recovery — reflection never recorded one. Rejecting such a pair would
/// break ordinary interop (a G# `List[[3]int32]` handed to a C#
/// `List<int[]>` parameter is the same CLR type), so the comparison
/// stays lenient exactly there. That is the same line #3924's
/// `IsMetadataRecoveredElement` draws, and the `interop-*` cases pin
/// it.
///
/// <b>Known residue, deliberately out of scope (#3998).</b>
/// `List[[]int32]` to `List[[3]int32]` is still accepted: a SLICE
/// argument is erased by the same binder mechanism, and retaining it
/// symbolically would touch every `List[[]T]` in the corpus. It matched
/// the then-current top-level behaviour, where `[]int32` to
/// `[3]int32` (and `[3]int32` to `[4]int32`) were likewise
/// accepted — a separate gap filed as #3998. The `bare-*` cases pinned
/// that behaviour so this PR's blast radius was visible.
///
/// <b>Since then (#3998).</b> The bare rule IS fixed: a fixed array's
/// length is part of its type, `[N]T` widens implicitly to `[]T`,
/// and nothing else converts implicitly into a `[N]T`. The two rows this
/// file pinned that #3998 flipped are kept, flipped, in
/// (cref:FlippedByIssue3998Cases). What #3998 left is narrower than
/// what it found: the SLICE-argument erasure above, and a member-projection
/// gap where a generic's member slot (`List[[3]int32]`'s `Add`) was
/// still read off the erased `List<int32[]>` rather than projected
/// through the retained `[3]int32`.
///
/// <b>Since then (#4012).</b> The member-projection gap is fixed too:
/// the slot is now projected through the retained `[3]int32`, so the row
/// this file pinned for it moved to
/// (cref:FlippedByIssue4012Cases). What was left of the original
/// residue was the SLICE-argument erasure alone.
///
/// <b>Since then (#4024).</b> That is now closed too, so the last
/// residue row this file carried moved to
/// (cref:FlippedByIssue4024Cases). This file declined it on the
/// reasoning that retaining a slice type argument "changes the representation
/// of every `List[[]T]` in the corpus" and bypasses the #1354
/// nullable-flags path. Both halves were true and neither turned out to bite:
/// #4024 measured every `.gs` under `samples/`, `src/Sdk/`,
/// `bench/`, `e2etests/` and `test-assets/` and found the
/// diagnostic output byte-identical, because a retained `[]T` fails every
/// arm of `ImportedTypeSymbol.HasSubstitutableTypeArgument` just as a
/// retained `[N]T` does, so no member projection moves; and the
/// nullable-flags concern turned out to be empty, because a slice carrying an
/// annotation (`[]string?`) was ALREADY retained through
/// `RequiresSymbolicProjection`'s
/// `ContainsReferenceNullableAnnotation` arm, so the arguments #4024
/// newly diverts off that branch are exactly the ones with no annotation to
/// lose (measured on the emitted `NullableAttribute` byte arrays, before
/// and after). What #4024 DID have to add is
/// the thing #3962 could not have seen: the #2735 guard reads `from`
/// alone, which sufficed only while every pair it stopped carried a fixed
/// array on both sides.
open class Issue3962GenericOverFixedArrayIdentityTests {
    /// Every accepting case compiles, IL-verifies, runs, and prints what it
    /// claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    @MemberData("UnchangedBareCases")
    func AFixedArrayGeneric_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3962_").FullName
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

    /// The metadata-recovery line: an imported `List<int[]>` carries
    /// no length, so it keeps converting both ways.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("InteropCases")
    func AMetadataRecoveredArray_StaysLenient(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3962_interop_").FullName
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

    /// Two instantiations that differ only in a fixed length are two types, and
    /// neither reaches the emitter.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    @MemberData("FlippedByIssue3998Cases")
    @MemberData("FlippedByIssue4012Cases")
    @MemberData("FlippedByIssue4024Cases")
    func ADifferentFixedLength_IsADifferentType(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3962_neg_").FullName
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

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library the interop cases link against. Nullable annotations are
        /// ENABLED so imported returns are not spuriously nullable.
        private const LibrarySource string = (`using System.Collections.Generic;

namespace Interop;

public static class ArrayProbes
{
    // A genuine ` + "`" + `List<int[]>` + "`" + ` parameter: the CLR type a G#
    // ` + "`" + `List[[3]int32]` + "`" + ` really has.
    public static int CountArrays(List<int[]> items) => items.Count;

    // A genuine ` + "`" + `List<int[]>` + "`" + ` return: metadata records no length at
    // all, so the comparison against ` + "`" + `List[[3]int32]` + "`" + ` must stay
    // lenient rather than reject on information nobody has.
    public static List<int[]> MakeArrays() => new List<int[]> { new[] { 10, 20, 30 } };

    // The NESTED shape: a plain CLR-backed constructed generic whose
    // symbolic type-argument vector is empty at every level.
    public static int CountNested(List<List<int[]>> items) => items.Count;

    public static List<List<int[]>> MakeNested() =>
        new List<List<int[]>> { new List<int[]> { new[] { 10, 20, 30 } } };

    // A VARIANT interface over a metadata array: the carve-out has to
    // reach the variance guard too, or this stops converting.
    public static IEnumerable<int[]> MakeSequence() => new[] { new[] { 10, 20, 30 } };

    public static int CountSequence(IEnumerable<int[]> items)
    {
        var n = 0;
        foreach (var _ in items)
        {
            n++;
        }

        return n;
    }
}`)

        /// Cases that must COMPILE, IL-VERIFY, RUN, and print what they claim. A
        /// fix that only stops accepting things would pass the rejection theory
        /// and fail every one of these.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // The instantiation the issue's repro builds, used for real: added to,
            // indexed, iterated, and passed through LINQ. Every one of those goes
            // out to reflection and back, which is exactly where a symbolic type
            // argument can be dropped again.
            yield[]object{"same-length-generic-round-trips-through-members", `package P
import System
import System.Collections.Generic
import System.Linq

func main2() {
    var l3 = List[[3]int32]()
    l3.Add([3]int32{1, 2, 3})
    l3.Add([3]int32{4, 5, 6})
    Console.WriteLine(l3.Count.ToString())
    Console.WriteLine(l3[1][2].ToString())
    for item in l3 {
        Console.WriteLine(item.Length.ToString())
    }

    Console.WriteLine(l3.First()[0].ToString())

    var alias List[[3]int32] = l3
    Console.WriteLine(alias.Count.ToString())
}

main2()`, []string{"2", "6", "3", "3", "1", "2"}}
            // The same length written twice must still be ONE type: the fix
            // escalates to a symbolic comparison, and that comparison has to
            // AGREE, not merely differ.
            yield[]object{"matching-lengths-are-still-identity-across-declarations", `package P
import System
import System.Collections.Generic

func takes(l List[[3]int32]) int32 {
    return l[0][1]
}

func makes() List[[3]int32] {
    var made = List[[3]int32]()
    made.Add([3]int32{7, 8, 9})
    return made
}

func main2() {
    var l List[[3]int32] = makes()
    Console.WriteLine(takes(l).ToString())

    var d = Dictionary[string, [3]int32]()
    d["k"] = [3]int32{4, 5, 6}
    var same Dictionary[string, [3]int32] = d
    Console.WriteLine(same["k"][2].ToString())
}

main2()`, []string{"8", "6"}}
            // A covariant interface over the SAME length still widens. The fix
            // must reject invariant length MISMATCH, not the upcast.
            yield[]object{"covariant-upcast-over-the-same-length-still-widens", `package P
import System
import System.Collections.Generic
import System.Linq

func counts(items IEnumerable[[3]int32]) int32 {
    return Enumerable.Count(items)
}

func main2() {
    var l3 = List[[3]int32]()
    l3.Add([3]int32{1, 2, 3})
    var widened IEnumerable[[3]int32] = l3
    Console.WriteLine(counts(widened).ToString())
    Console.WriteLine(counts(l3).ToString())
}

main2()`, []string{"1", "1"}}
            // A nested constructed generic over a matching length is one type too.
            yield[]object{"nested-generic-over-the-same-length-is-one-type", `package P
import System
import System.Collections.Generic

func main2() {
    var outer = List[List[[3]int32]]()
    var inner = List[[3]int32]()
    inner.Add([3]int32{1, 2, 3})
    outer.Add(inner)

    var alias List[List[[3]int32]] = outer
    Console.WriteLine(alias[0][0][1].ToString())
}

main2()`, []string{"2"}}
            // A SAME-COMPILATION generic over a fixed array. This is the shape
            // that reaches the new metadata traversal during EMIT, when the
            // argument's CLR type is still a `TypeBuilder` — the reflection guard
            // in `ContainsMetadataRecoveredArray` must not change the answer or
            // throw. Round-trips the value through a field and a method so the
            // emitted signatures are exercised, not just the classification.
            yield[]object{"same-compilation-generic-over-a-fixed-array-round-trips", `package P
import System

class Box[T] {
    var v T

    init(value T) {
        v = value
    }

    func Get() T {
        return v
    }
}

func main2() {
    var b = Box[[3]int32]([3]int32{1, 2, 3})
    var alias Box[[3]int32] = b
    Console.WriteLine(alias.Get()[1].ToString())
    Console.WriteLine(b.v[2].ToString())
}

main2()`, []string{"2", "3"}}
            // A STATIC generic receiver over a matching length: the third
            // retention site (`TryCloseImportedGenericTypeReceiver`) has to build
            // the symbolic view and still produce verifiable IL parented at the
            // constructed TypeSpec.
            yield[]object{"static-generic-receiver-over-a-matching-length-runs", `package P
import System
import System.Collections.Generic

func main2() {
    var c EqualityComparer[[3]int32] = EqualityComparer[[3]int32].Default
    var a = [3]int32{1, 2, 3}
    Console.WriteLine(c.Equals(a, a).ToString())
    Console.WriteLine(EqualityComparer[[3]int32].Default.Equals(a, a).ToString())
}

main2()`, []string{"True", "True"}}
            // A nullable REFERENCE element inside the fixed array. Retaining the
            // symbolic argument bypasses the #1354 branch that attaches the DFS
            // nullable-flags array (it only runs when NO symbolic argument is
            // kept), so the inner `?` now has to survive through
            // `NullableFlagsBuilder` on the `GetConstructed` path instead.
            yield[]object{"nullable-reference-element-inside-a-fixed-array", `package P
import System
import System.Collections.Generic

func makes() List[[3]string?] {
    var l = List[[3]string?]()
    l.Add([3]string?{"a", nil, "c"})
    return l
}

func main2() {
    var l = makes()
    Console.WriteLine(l.Count.ToString())
    Console.WriteLine(l[0][0]!!)
}

main2()`, []string{"1", "a"}}
            // A same-compilation element inside the fixed array: the argument now
            // carries BOTH reasons to stay symbolic, and the two must compose.
            // (`List[[3]Foo].Add` is a separate, PRE-EXISTING member-projection gap
            // — red on `main` too — filed as #3998, so this case moves the value
            // through the outer list instead.)
            yield[]object{"same-compilation-element-inside-a-matching-fixed-array", `package P
import System
import System.Collections.Generic

struct Foo {
    var X int32
}

func takes(l List[[3]Foo]) int32 {
    return l.Count
}

func main2() {
    var l = List[[3]Foo]()
    var alias List[[3]Foo] = l
    Console.WriteLine(takes(alias).ToString())

    var arr = [3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}
    Console.WriteLine(arr[2].X.ToString())
}

main2()`, []string{"0", "3"}}
        }

        /// Interop cases: the metadata-recovery line the fix must NOT cross. Both
        /// were green before the fix and must stay green — an array that came back
        /// through reflection carries no length, so a comparison against
        /// `[3]int32` stays lenient instead of rejecting on information
        /// neither side has.
        /// @returns Name, G# source, expected stdout lines.
        func InteropCases() sequence[[]object] {
            yield[]object{"interop-fixed-array-generic-reaches-a-clr-list-of-arrays", `package P
import System
import System.Collections.Generic
import Interop

func main2() {
    var l3 = List[[3]int32]()
    l3.Add([3]int32{1, 2, 3})
    Console.WriteLine(ArrayProbes.CountArrays(l3).ToString())

    var back List[[3]int32] = ArrayProbes.MakeArrays()
    Console.WriteLine(back[0][1].ToString())
}

main2()`, []string{"1", "20"}}
            // Review finding 4 predicted this would break: a NESTED
            // metadata-recovered array (`List<List<int[]>>`) reached through a
            // plain CLR-backed constructed generic, whose symbolic type-argument
            // vector is empty. Measured green before and after — pinned so the
            // carve-out's reach is covered rather than argued about.
            yield[]object{"interop-nested-metadata-arrays-convert-both-ways", `package P
import System
import System.Collections.Generic
import Interop

func main2() {
    var nested = List[List[[3]int32]]()
    Console.WriteLine(ArrayProbes.CountNested(nested).ToString())

    var back List[List[[3]int32]] = ArrayProbes.MakeNested()
    Console.WriteLine(back[0][0][1].ToString())
}

main2()`, []string{"0", "20"}}
            // The metadata carve-out must survive the new variance guard: a
            // C# `IEnumerable<int[]>` records no length, so it still flows into an
            // `IEnumerable[[3]int32]` slot and back out, even though two SYMBOLIC
            // instantiations differing in length no longer do.
            yield[]object{"interop-metadata-array-still-crosses-a-variant-interface", `package P
import System
import System.Collections.Generic
import Interop

func main2() {
    var seq IEnumerable[[3]int32] = ArrayProbes.MakeSequence()
    Console.WriteLine(ArrayProbes.CountSequence(seq).ToString())

    var l3 = List[[3]int32]()
    l3.Add([3]int32{1, 2, 3})
    Console.WriteLine(ArrayProbes.CountSequence(l3).ToString())
}

main2()`, []string{"1", "1"}}
        }

        /// Cases that must be REJECTED. Each was accepted before the fix — that is
        /// the point of the change — and none may reach the emitter (GS9998).
        /// @returns Name, G# source, a substring the diagnostics must name.
        func RejectedCases() sequence[[]object] {
            // The issue's headline row.
            yield[]object{"different-lengths-do-not-convert", `package P
import System.Collections.Generic

var l3 = List[[3]int32]()
var l4 List[[4]int32] = l3`, "'System.Collections.Generic.List[[3]int32]' to 'System.Collections.Generic.List[[4]int32]'"}
            // The same conflation in a two-argument generic, on the second
            // position, so a fix that only inspects argument 0 stays red.
            yield[]object{"different-lengths-do-not-convert-in-a-map-value-position", `package P
import System.Collections.Generic

var d3 = Dictionary[string, [3]int32]()
var d4 Dictionary[string, [4]int32] = d3`, "'System.Collections.Generic.Dictionary[string, [3]int32]' to 'System.Collections.Generic.Dictionary[string, [4]int32]'"}
            // The same conflation in ARGUMENT position, which is a different
            // classification entry point (GS0154, not GS0155).
            yield[]object{"different-lengths-do-not-satisfy-a-parameter", `package P
import System.Collections.Generic

func wants(l List[[4]int32]) {
}

var l3 = List[[3]int32]()
wants(l3)`, "requires a value of type 'System.Collections.Generic.List[[4]int32]'"}
            // Declared-type form: neither side goes through the construction
            // binder, so this pins the type-clause binder independently.
            yield[]object{"different-lengths-do-not-convert-between-declared-types", `package P
import System.Collections.Generic

func wants(l List[[4]int32]) int32 {
    return l.Count
}

func pass(l List[[3]int32]) int32 {
    return wants(l)
}

System.Console.WriteLine(pass(List[[3]int32]()).ToString())`, "requires a value of type 'System.Collections.Generic.List[[4]int32]'"}
            // Nested one level down: the length must be found at any depth.
            yield[]object{"different-lengths-nested-inside-a-generic-argument", `package P
import System.Collections.Generic

func wants(l List[List[[4]int32]]) {
}

var outer = List[List[[3]int32]]()
wants(outer)`, "requires a value of type 'System.Collections.Generic.List[System.Collections.Generic.List[[4]int32]]'"}
            // Behind a slice wrapper, so the recursion through GetWrappedTypes is
            // load-bearing rather than incidental.
            yield[]object{"different-lengths-behind-a-slice-wrapper", `package P
import System.Collections.Generic

func wants(l List[[][4]int32]) {
}

var outer = List[[][3]int32]()
wants(outer)`, "requires a value of type 'System.Collections.Generic.List[[][4]int32]'"}
            // The FULLY-QUALIFIED construction spelling resolves its type arguments
            // in a third place (`ExpressionBinder.Access`), which had its own copy
            // of the retention rule. Without that site fixed, this row still
            // compiles while every row above is rejected.
            yield[]object{"different-lengths-through-the-qualified-construction-spelling", `package P
import System.Collections.Generic

var l3 = System.Collections.Generic.List[[3]int32]()
var l4 List[[4]int32] = l3`, "'System.Collections.Generic.List[[3]int32]' to 'System.Collections.Generic.List[[4]int32]'"}
            // Review finding 2. Generic VARIANCE must not readmit a mismatch the
            // identity comparison rejected: `IEnumerable[T]` is covariant, and the
            // bare `[3]int32` -> `[4]int32` conversion is implicit (#3998), so the
            // covariant slot accepted the pair until the shape mismatch was
            // rejected before variance was applied.
            yield[]object{"covariance-does-not-readmit-a-length-mismatch", `package P
import System.Collections.Generic

var l3 = List[[3]int32]()
var e3 IEnumerable[[3]int32] = l3
var e4 IEnumerable[[4]int32] = e3`, "'System.Collections.Generic.IEnumerable[[3]int32]' to 'System.Collections.Generic.IEnumerable[[4]int32]'"}
            // The contravariant half of the same rule (`IComparer[in T]`), in the
            // direction contravariance would otherwise allow.
            yield[]object{"contravariance-does-not-readmit-a-length-mismatch", `package P
import System
import System.Collections.Generic

func wants3(c IComparer[[3]int32]) int32 {
    return 0
}

func pass4(c IComparer[[4]int32]) int32 {
    return wants3(c)
}

Console.WriteLine(pass4(Comparer[[4]int32].Default).ToString())`, "requires a value of type 'System.Collections.Generic.IComparer[[3]int32]'"}
            // Review finding 3. The STATIC generic receiver is resolved by a
            // fourth code path of its own; without the retention there,
            // `EqualityComparer[[3]int32].Default` is exposed as a metadata-only
            // `EqualityComparer<int32[]>` and flows into the `[4]` slot through the
            // metadata-recovery leniency.
            yield[]object{"static-generic-receiver-discriminates-lengths", `package P
import System.Collections.Generic

var c4 EqualityComparer[[4]int32] = EqualityComparer[[3]int32].Default`, "'System.Collections.Generic.EqualityComparer[[3]int32]' to 'System.Collections.Generic.EqualityComparer[[4]int32]'"}
            // The same-compilation counterpart of the headline row. Green on
            // `main` too — a same-compilation generic's arguments were already
            // compared symbolically — so it is a CONTROL that the new metadata
            // traversal did not loosen that path while widening leniency for
            // genuinely reflected shapes.
            yield[]object{"same-compilation-generic-still-discriminates-lengths", `package P
import System

class Box[T] {
    var v T

    init(value T) {
        v = value
    }
}

func main2() {
    var b = Box[[3]int32]([3]int32{1, 2, 3})
    var bad Box[[4]int32] = b
    Console.WriteLine(bad.v[0].ToString())
}

main2()`, "'Box[[3]int32]' to 'Box[[4]int32]'"}
            // #3924's own control, restated here: a same-compilation element must
            // still discriminate, and this PR must not have traded one erasure for
            // another.
            yield[]object{"same-compilation-elements-are-still-not-conflated", `package P
import System.Collections.Generic

struct Foo {
    var X int32
}

struct Bar {
    var Y int32
}

func wants(l List[Foo]) {
}

var bars = List[Bar]()
wants(bars)`, "requires a value of type 'System.Collections.Generic.List[Foo]'"}
            // A fixed length INSIDE a same-compilation-element generic: both
            // erasure reasons at once.
            yield[]object{"different-lengths-over-a-same-compilation-element", `package P
import System.Collections.Generic

struct Foo {
    var X int32
}

func wants(l List[[4]Foo]) {
}

var l3 = List[[3]Foo]()
wants(l3)`, "requires a value of type 'System.Collections.Generic.List[[4]Foo]'"}
        }

        /// Bare-level behaviour this PR deliberately did not change, pinned so the
        /// blast radius stayed visible. #3998 has since fixed the bare rule, so
        /// what remains here is the part that survived it: the widening direction,
        /// and the two erasure gaps #3998 also left. The rows it FLIPPED are in
        /// (cref:FlippedByIssue3998Cases), not deleted.
        /// @returns Name, G# source, expected stdout lines.
        func UnchangedBareCases() sequence[[]object] {
            // #3998 flipped the first two lines of this case (`var a4 [4]int32 =
            // a3` and `takes4(a3)`) into errors — they are now the
            // `bare-fixed-array-lengths-no-longer-interconvert` rejection row
            // below. The third line survives, and is the direction #3998
            // deliberately kept implicit: dropping a KNOWN length for an unknown
            // one is a widening, so a fixed array still reaches every `[]T` slot.
            yield[]object{"bare-fixed-array-still-widens-to-a-slice", `package P
import System

func main2() {
    var a3 [3]int32 = [3]int32{1, 2, 3}
    var s []int32 = a3
    Console.WriteLine(s.Length.ToString())
}

main2()`, []string{"3"}}
            // FLIPPED BY #4012, and moved to `FlippedByIssue4012Cases` below —
            // `member-argument-still-follows-the-erased-member-slot` lived here.
            // The history is worth keeping: review finding 1 pinned the `take3`
            // and `xs.Add` lines TOGETHER, on the reasoning that both were the one
            // bare rule seen at two levels. #3998 split them, fixing `take3` and
            // leaving `xs.Add` accepted; #4012 has now closed the second half, so
            // the original reasoning turns out to have been right about the
            // OUTCOME and wrong about the mechanism — they are two different
            // gates, and it took two PRs to shut both.
            // FLIPPED BY #4024, and moved to `FlippedByIssue4024Cases` below —
            // `slice-argument-still-reaches-a-fixed-array-generic` lived here.
            // This file declined the SLICE half on the reasoning that retaining a
            // slice type argument "changes the representation of every `List[[]T]`
            // in the corpus". The representation claim was right; the risk it
            // implied was not. #4024 measured the corpus — every `.gs` under
            // `samples/`, `src/Sdk/`, `bench/`, `e2etests/` and `test-assets/` —
            // and the diagnostic output is byte-identical before and after,
            // because a retained `[]T` still fails every arm of
            // `ImportedTypeSymbol.HasSubstitutableTypeArgument` and so no member
            // projection moves. What retention buys is the ONE thing that was
            // missing: a source-spelled `[]T` argument distinguishable from a
            // reflected `T[]`.

        }

        /// The rows this file pinned as ACCEPTED behaviour and #3998 turned into
        /// errors. Kept here, flipped rather than deleted, so the change reads as
        /// deliberate: #3998 made a fixed array's declared length part of its type
        /// at the bare level, which is what these two cases measured before.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func FlippedByIssue3998Cases() sequence[[]object] {
            yield[]object{"bare-fixed-array-lengths-no-longer-interconvert", `package P
import System

func main2() {
    var a3 [3]int32 = [3]int32{1, 2, 3}
    var a4 [4]int32 = a3
    Console.WriteLine(a4.Length.ToString())
}

main2()`, "Cannot convert type '[3]int32' to '[4]int32'"}
            yield[]object{"member-argument-length-follows-the-bare-conversion-rule", `package P
import System

func take3(a [3]int32) int32 {
    return a[0]
}

func main2() {
    Console.WriteLine(take3([4]int32{1, 2, 3, 4}).ToString())
}

main2()`, "requires a value of type '[3]int32' but was given a value of type '[4]int32'"}
        }

        /// The row this file pinned as ACCEPTED behaviour and #4012 turned into an
        /// error. Kept here, flipped rather than deleted, for the same reason
        /// (cref:FlippedByIssue3998Cases) exists.
        /// @remarks #4012 closed the member-projection gap this row measured: the entry and
        /// exit gates of
        /// `ConversionClassifier.TrySubstituteParameterTypeFromReceiver` now
        /// admit a `TypeSymbol.ContainsFixedLengthArray` type argument, so
        /// `Add`'s parameter is the `[3]int32` this receiver retained
        /// rather than the `int32[]` reflection reports off the erased
        /// `List<int32[]>`. Note what it was NOT: #4002's hand-off
        /// predicted `ImportedTypeSymbol.HasSubstitutableTypeArgument`, #3998
        /// measured that widening and it changed nothing, and the note that
        /// recorded the negative result was correct — the gate that decides is the
        /// inline one, in a different file.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func FlippedByIssue4012Cases() sequence[[]object] {
            yield[]object{"member-argument-follows-the-projected-member-slot", `package P
import System
import System.Collections.Generic

func main2() {
    var xs = List[[3]int32]()
    xs.Add([4]int32{5, 6, 7, 8})
    Console.WriteLine(xs.Count.ToString())
}

main2()`, "Cannot convert type '[4]int32' to '[3]int32'"}
        }

        /// The row this file pinned as ACCEPTED behaviour and #4024 turned into an
        /// error. Kept here, flipped rather than deleted, for the same reason
        /// (cref:FlippedByIssue3998Cases) exists.
        /// @remarks #4024 closed the SLICE half. This file retained `[N]T` as a
        /// symbolic type argument but not `[]T`, which left
        /// `List[[]int32]` with an EMPTY symbolic vector — indistinguishable
        /// from a metadata-recovered `List<int[]>`, whose shape really
        /// is unknowable — so `ContainsMetadataRecoveredArray` kept the
        /// lenient CLR comparison and the two spellings converted freely.
        /// `TypeSymbol.ContainsSourceArrayShape` now covers both spellings at
        /// this file's four RETENTION gates; the comparison predicates below still
        /// read `ContainsFixedLengthArray`, unchanged. #4024 also had to widen
        /// the #2735 guard, which read `from` ALONE — sufficient only while
        /// every pair it stopped carried a fixed array on both sides.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func FlippedByIssue4024Cases() sequence[[]object] {
            yield[]object{"slice-argument-no-longer-reaches-a-fixed-array-generic", `package P
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
