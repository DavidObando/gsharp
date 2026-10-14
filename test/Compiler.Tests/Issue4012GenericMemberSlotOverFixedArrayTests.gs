// <copyright file="Issue4012GenericMemberSlotOverFixedArrayTests.cs" company="GSharp">
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

/// Issue #4012: a generic's member slot over a fixed-length array was read
/// from the erased CLR shape rather than projected through the
/// `[N]T` the receiver still carries, and a `[N]T` argument over a
/// same-compilation element produced no effective CLR type at all.
/// @remarks <b>Two sites, one family.</b> Both halves are the same sentence —
/// "a structural symbol is read through its CLR erasure" — but they fail in
/// different code and were measured apart.
///
/// <b>Sub-case 1, the TARGET.</b>
/// `ConversionClassifier.TrySubstituteParameterTypeFromReceiver` is the
/// helper that rewrites an imported member's parameter through the receiver's
/// retained type arguments. Its entry gate admitted a type argument only when
/// `TypeSymbol.RequiresSymbolicProjection` said so or it was a tuple. A
/// `[3]int32` is neither — it has a perfectly real `int32[]`
/// `ClrType`, which is precisely the problem: that `ClrType` is
/// shared with `[]int32` and with an array of every other length. So the
/// helper bailed, `Add`'s parameter stayed the `int32[]` reflection
/// reports off the erased `List<int32[]>`, and
/// `List[[3]int32]().Add([4]int32{…})` was accepted with
/// `xs[0].Length == 4`. The exit filter needed the same widening or the
/// correctly recovered `[3]int32` was discarded again.
///
/// <b>NOT <c>HasSubstitutableTypeArgument</c>.</b> #4002's hand-off
/// predicted that widening `ImportedTypeSymbol.HasSubstitutableTypeArgument`
/// would close this; #3998 applied the widening, measured it, and it changed
/// nothing. The ordinary imported instance-call path never consults that
/// property for parameter types. The gate that decides is the inline one in
/// `TrySubstituteParameterTypeFromReceiver`.
///
/// <b>Sub-case 2, the ARGUMENT.</b>
/// `ExpressionBinder.GetEffectiveArgumentClrTypeForOverloadResolution`
/// rides an argument whose `ClrType` is null through to its ADR-0004
/// erasure so overload resolution can rank candidates. It had an arm for
/// `[]T` (#2182) and one for `[N,M]T`, and none for `[N]T`. A
/// `[3]Foo` over a same-compilation `Foo` therefore produced NO CLR
/// type, and every imported-call probe abandoned resolution before looking at
/// a candidate: `List[[3]Foo]().Add([3]Foo{…})` reported `GS0159
/// "Cannot find function Add"` while `List[[]Foo]().Add([]Foo{…})` and
/// `List[[3]int32]().Add([3]int32{…})` both bound. That is the "needs
/// BOTH a symbolic element and the fixed-array shape" signature the issue
/// reports; the declared length is not consulted by this arm at all.
///
/// <b>Which CALL PATH, measured.</b> The INSTANCE-call path only.
/// `TryResolveAndBindClrInstanceCall` abandons the whole call when an
/// argument yields no effective CLR type, while a STATIC or EXTENSION imported
/// call has its own `MemberLookup.TryProjectErasedClrType` fallback
/// (#833 — the #3876 note inside
/// `GetEffectiveArgumentClrTypeForOverloadResolution` says exactly that
/// this is the one probe that already consulted it). So a `[3]T` reached
/// a static imported slot all along, and only member calls such as
/// `List[[3]Foo]().Add(…)` reported `GS0159`. The discriminating
/// rows for sub-case 2 are the four instance calls in
/// (cref:NewlyAcceptedCases), all red on the parent commit; the static
/// row in (cref:InteropCases) is green there and is a must-not-change
/// row.
///
/// <b>The leniency that had to be withdrawn.</b>
/// `BindClrParameterConversions` re-binds a CLR argument with
/// `allowExplicit: true`. With sub-case 1 fixed, the CLR-backed pair
/// (`[4]int32` at a projected `[3]int32`) never reaches that arm —
/// `NeedsBindClrParameterConversion` sees one `int32[]` on both
/// sides — and correctly reported `GS0156` from the #2391 arm, while the
/// same-compilation pair (`[4]Foo` at `[3]Foo`) DID reach it and was
/// silently accepted, because `[N]T -> [M]T` is EXPLICIT by design
/// (#3998's cast reinterprets, it does not resize). The leniency is now
/// withdrawn for a `[N]T` target only, so both spellings agree.
///
/// <b>Sub-case 3, the SLICE half — out of scope here, closed by
/// #4024.</b> `List[[]int32]` converted to `List[[3]int32]` because a
/// SLICE type argument was erased to `T[]` by
/// `Binder.ProjectGenericArgument` before any comparison could see it — a
/// different mechanism from either half here, and the one #3962 declined
/// because retaining it symbolically changes the representation of every
/// `List[[]T]` in the corpus and bypasses the #1354 nullable-flags path.
/// #4024 measured both concerns and did it: `ContainsSourceArrayShape`
/// retains both G# array spellings at the four RETENTION gates, and the #2735
/// guard, which read `from` alone, was widened to the two-sided
/// predicate. THIS file's gates were not touched, and did not need to be:
/// `[]T` to `T[]` is a faithful projection, so a slice never needed
/// the symbolic rescue a `[N]T` did at a member slot. The row that pinned
/// sub-case 3 is kept, flipped, in (cref:FlippedByIssue4024Cases).
open class Issue4012GenericMemberSlotOverFixedArrayTests {
    /// A projected fixed-array slot rejects a different shape, and says so.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    @MemberData("FlippedByIssue4024Cases")
    func AProjectedFixedArraySlot_RejectsAnotherShape(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4012_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The point of sub-case 2 is that these now fail on the LENGTH
            // rather than dead-ending before overload resolution ever ran.
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal)
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
    @MemberData("NewlyAcceptedCases")
    @MemberData("UnchangedCases")
    func ALegitimateMemberCall_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4012_").FullName
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
        let tempDir = Directory.CreateTempSubdirectory("gs_4012_interop_").FullName
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

    /// Issue #3989's gate is unaffected: a `[N]Foo` now presents as
    /// `object[]` to applicability exactly as a `[]Foo` already did,
    /// and a GENUINE `object[]` parameter still refuses both. Sub-case 2
    /// widens what reaches overload resolution, not what it accepts.
    @Fact
    func AFixedArrayOverAUserType_DoesNotReachAGenuineObjectArrayParameter() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4012_erased_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            const Source = `package P
import System
import Interop

struct Foo { var X int32 }

func main2() {
    Console.WriteLine(ArrayProbes.CountObjects([3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}).ToString())
}

main2()`
            let appPath = Path.Combine(tempDir, "erased.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(appPath),
                (`a ` + "\u0060" + `[3]Foo` + "\u0060" + ` must not reach ` + "\u0060" + `object[]` + "\u0060" + `. Log:
` + "$appLog")
            )
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The `[]Foo` control takes the same route and is refused the same
            // way, which is what "no better, no worse" means here.
            const SliceControl = `package P
import System
import Interop

struct Foo { var X int32 }

func main2() {
    Console.WriteLine(ArrayProbes.CountObjects([]Foo{Foo{X: 1}}).ToString())
}

main2()`
            let controlPath = Path.Combine(tempDir, "erasedControl.dll")
            let controlLog = Compile(
                tempDir,
                "Control.gs",
                SliceControl,
                controlPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.False(
                File.Exists(controlPath),
                (`a ` + "\u0060" + `[]Foo` + "\u0060" + ` must not reach ` + "\u0060" + `object[]` + "\u0060" + ` either. Log:
` + "$controlLog")
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library the interop case links against. A genuine CLR
        /// `int[]` has no length in metadata, which is the whole point of the
        /// line this fix must not cross.
        private const LibrarySource string = (`using System.Collections.Generic;

namespace Interop;

public static class ArrayProbes
{
    // A genuine ` + "`" + `int[]` + "`" + ` parameter. A fixed array keeps reaching it:
    // metadata records no length to disagree with.
    public static int Count(int[] items) => items.Length;

    // A GENUINE ` + "`" + `object[]` + "`" + ` parameter — the shape a ` + "`" + `[3]Foo` + "`" + ` erases
    // to. Sub-case 2's arm makes ` + "`" + `[N]Foo` + "`" + ` present here exactly as
    // ` + "`" + `[]Foo` + "`" + ` already did; neither may reach it, and both are refused
    // by the same #3989 gate.
    public static int CountObjects(object[] items) => items.Length;

    // A generic slot whose element is inferred. ` + "`" + `[N]T` + "`" + ` must rank here
    // exactly as ` + "`" + `[]T` + "`" + ` does.
    public static int CountAny<T>(T[] items) => items.Length;

    // A ` + "`" + `List<int[]>` + "`" + ` built on the C# side, so the G# receiver comes
    // back from METADATA with no length anywhere in it.
    public static List<int[]> MakeList() => new() { new[] { 1, 2, 3 } };
}`)

        /// The rows this issue fixes: a member slot on a generic over a
        /// fixed-length array now enforces the declared length.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func RejectedCases() sequence[[]object] {
            // Sub-case 1, the reported row. `List[T]` also exposes the non-generic
            // `IList.Add(object)`, so this row alone is not proof — see the
            // `Stack` row below, which has no such sibling.
            yield[]object{"a-generic-member-slot-enforces-the-receivers-declared-length", `package P
import System
import System.Collections.Generic

func main2() {
    var xs = List[[3]int32]()
    xs.Add([4]int32{5, 6, 7, 8})
    Console.WriteLine(xs.Count.ToString())
}

main2()`, "Cannot convert type '[4]int32' to '[3]int32'"}
            // `Stack[T].Push(T)` has no `object` sibling at all, so this isolates
            // the projection gap by itself. It is the row the issue named as the
            // one that proves the fix.
            yield[]object{"a-member-with-no-object-overload-enforces-the-declared-length", `package P
import System
import System.Collections.Generic

func main2() {
    var st = Stack[[3]int32]()
    st.Push([4]int32{1, 2, 3, 4})
    Console.WriteLine(st.Count.ToString())
}

main2()`, "Cannot convert type '[4]int32' to '[3]int32'"}
            // The two halves compose. Sub-case 2's arm is what lets a `[N]Foo`
            // argument into overload resolution at all; sub-case 1's projection is
            // what makes the target `[3]Foo` once it is there. Before this PR the
            // outer call reported GS0159 and the length was never examined.
            yield[]object{"a-same-compilation-element-enforces-the-declared-length-too", `package P
import System
import System.Collections.Generic

struct Foo { var X int32 }

func main2() {
    var a = List[[3]Foo]()
    a.Add([4]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}, Foo{X: 4}})
    Console.WriteLine(a.Count.ToString())
}

main2()`, "Cannot convert type '[4]Foo' to '[3]Foo'"}
            // The other direction of #3998's rule at the same projected slot:
            // nothing converts implicitly INTO a `[N]T` except a `[N]T` of the
            // same length, and an unknown length is not a matching one. Measured
            // as ACCEPTED before this PR — the erased `object[]` slot took it.
            yield[]object{"a-slice-argument-does-not-fill-a-projected-fixed-array-slot", `package P
import System
import System.Collections.Generic

struct Foo { var X int32 }

func main2() {
    var a = List[[3]Foo]()
    a.Add([]Foo{Foo{X: 1}})
    Console.WriteLine(a.Count.ToString())
}

main2()`, "Cannot convert type '[]Foo' to '[3]Foo'"}
            // The same rule at a G#-DECLARED parameter, unchanged by this PR and
            // restated here as the control: the projected slot must agree with the
            // bare one, which is the whole claim of the fix.
            yield[]object{"control-a-declared-fixed-array-parameter-still-rejects-a-slice", `package P
import System

struct Foo { var X int32 }

func takeFixed(v [3]Foo) int32 { return v.Length }

func main2() {
    var s = []Foo{Foo{X: 1}}
    Console.WriteLine(takeFixed(s).ToString())
}

main2()`, "requires a value of type '[3]Foo'"}
        }

        /// Programs that were REFUSED before this PR and now compile, run and
        /// verify. Every one of them needed sub-case 2's argument ride-through.
        /// @returns Name, G# source, expected stdout lines.
        func NewlyAcceptedCases() sequence[[]object] {
            // Sub-case 2, the reported row: `List[[N]Foo].Add` was unreachable.
            yield[]object{"a-fixed-array-over-a-same-compilation-element-reaches-a-generic-member", `package P
import System
import System.Collections.Generic

struct Foo { var X int32 }

func main2() {
    var a = List[[3]Foo]()
    a.Add([3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}})
    Console.WriteLine(a.Count.ToString())
    Console.WriteLine(a[0].Length.ToString())
    Console.WriteLine(a[0][1].X.ToString())
}

main2()`, []string{"1", "3", "2"}}
            // `Stack[T].Push(T)` again — no `object` sibling, so this is the
            // ride-through by itself rather than a lucky match on a wider slot.
            yield[]object{"a-fixed-array-over-a-user-struct-reaches-a-member-with-no-object-overload", `package P
import System
import System.Collections.Generic

struct Foo { var X int32 }

func main2() {
    var st = Stack[[3]Foo]()
    st.Push([3]Foo{Foo{X: 7}, Foo{X: 8}, Foo{X: 9}})
    Console.WriteLine(st.Count.ToString())
    Console.WriteLine(st.Peek().Length.ToString())
    Console.WriteLine(st.Peek()[2].X.ToString())
}

main2()`, []string{"1", "3", "9"}}
            // The argument does not have to be a literal: a local of the same type
            // took the identical path and failed the identical way.
            yield[]object{"a-fixed-array-local-over-a-user-struct-reaches-a-generic-member", `package P
import System
import System.Collections.Generic

struct Foo { var X int32 }

func main2() {
    var a = List[[3]Foo]()
    var v = [3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}
    a.Add(v)
    Console.WriteLine(a.Count.ToString())
}

main2()`, []string{"1"}}
            // An OPEN element is the other half of "no CLR identity". Inside a
            // generic function a `[3]T` argument had no effective CLR type either.
            yield[]object{"a-fixed-array-over-an-open-type-parameter-reaches-a-generic-member", `package P
import System
import System.Collections.Generic

func fill[T](first T, second T, third T) int32 {
    var a = List[[3]T]()
    a.Add([3]T{first, second, third})
    return a.Count
}

func main2() {
    Console.WriteLine(fill[int32](1, 2, 3).ToString())
    Console.WriteLine(fill[string]("a", "b", "c").ToString())
}

main2()`, []string{"1", "1"}}
        }

        /// Programs that bound before this PR and must bind identically after it —
        /// the blast radius of both arms, stated as executable rows.
        /// @returns Name, G# source, expected stdout lines.
        func UnchangedCases() sequence[[]object] {
            // The matching length still binds, now through the PROJECTED
            // `[3]int32` slot rather than the erased `int32[]` one.
            yield[]object{"a-matching-length-still-reaches-every-member-on-the-same-receiver", `package P
import System
import System.Collections.Generic

func main2() {
    var a = List[[3]int32]()
    a.Add([3]int32{1, 2, 3})
    a.Insert(0, [3]int32{7, 8, 9})
    Console.WriteLine(a.Count.ToString())
    Console.WriteLine(a[0].Length.ToString())
    Console.WriteLine(a[0][2].ToString())
    var arr = a.ToArray()
    Console.WriteLine(arr.Length.ToString())
    a.AddRange(arr)
    Console.WriteLine(a.Count.ToString())
}

main2()`, []string{"2", "3", "9", "2", "4"}}
            // A fixed array still WIDENS to a slice at a generic member slot —
            // #3998's implicit direction, which the projection must not withdraw.
            yield[]object{"a-fixed-array-still-widens-to-a-slice-type-argument", `package P
import System
import System.Collections.Generic

func main2() {
    var a = List[[]int32]()
    a.Add([3]int32{1, 2, 3})
    Console.WriteLine(a.Count.ToString())
    Console.WriteLine(a[0].Length.ToString())
}

main2()`, []string{"1", "3"}}
            // FLIPPED BY #4024, and moved to `FlippedByIssue4024Cases` below —
            // `residue-a-slice-type-argument-still-reaches-a-fixed-array-generic`
            // lived here, pinning sub-case 3 as deliberately unchanged. #4024
            // retained the SLICE spelling at this PR's sibling gates — the four
            // RETENTION gates in the binder, not the member-slot gates this file
            // widened — so `List[[]int32]` and `List[[3]int32]` are now two types.
            // Note what did NOT have to change with it: the entry gate and exit
            // filter of `ConversionClassifier.TrySubstituteParameterTypeFromReceiver`
            // still read `ContainsFixedLengthArray`, because `[]T` to `T[]` is a
            // FAITHFUL projection and needs no symbolic rescue at a member slot.
            // The row directly above — `List[[]int32]().Add([3]int32{…})` — is the
            // proof, and is still green.
            //
            // The matching pins that flipped with it are
            // `Issue3998FixedArrayLengthConversionTests.FlippedByIssue4024Cases`
            // and `Issue3962GenericOverFixedArrayIdentityTests.FlippedByIssue4024Cases`.
            // A tuple type argument on the same receiver still projects the way
            // #3560/#4000 left it — the widened gate is additive, not a rewrite.
            yield[]object{"a-tuple-type-argument-still-projects-on-the-same-gate", `package P
import System
import System.Collections.Generic

func main2() {
    var a = List[(int32, string)]()
    a.Add((1, "x"))
    Console.WriteLine(a.Count.ToString())
    Console.WriteLine(a[0].Item2)
}

main2()`, []string{"1", "x"}}
        }

        /// The interop line: an array recovered from METADATA carries no length,
        /// so a fixed array keeps reaching it in both directions. Sub-case 2's
        /// widening must not change what a genuine CLR slot accepts.
        /// @returns Name, G# source, expected stdout lines.
        func InteropCases() sequence[[]object] {
            // Review feedback on #4030, and the measurement that followed it. The
            // reviewer was right that the old second line
            // (`ArrayProbes.CountAny[int32]([5]int32{…})`) proved nothing: a
            // `[5]int32` already HAS a concrete `int32[]` `ClrType`, so
            // `GetEffectiveArgumentClrType` answers before sub-case 2's arm is
            // consulted. It is now called from an OPEN generic function, so the
            // argument really is a `[3]T` with no CLR type of its own — and
            // `[3]Foo` beside it, whose erasure is `object[]`.
            //
            // MEASURED, and worth stating plainly: this row is STILL green on the
            // parent commit. A STATIC or EXTENSION imported call has its own
            // `MemberLookup.TryProjectErasedClrType` fallback (issue #833 — see
            // `TryBindImportedExtensionCall`, and the #3876 note inside
            // `GetEffectiveArgumentClrTypeForOverloadResolution` itself, which
            // says exactly that this is the ONE probe that already consulted it),
            // so a `[3]T` argument reached a static imported slot all along. The
            // INSTANCE-call path (`TryResolveAndBindClrInstanceCall`) has no such
            // fallback and simply `return false`s — which is why sub-case 2
            // manifests as `List[[3]Foo]().Add(…)` reporting GS0159 while the
            // static call beside it binds. The discriminating rows for sub-case 2
            // are the four in `NewlyAcceptedCases`, all of which are instance
            // calls and all of which are red on the parent. This one is here as a
            // MUST-NOT-CHANGE row for the static path, not as proof.
            yield[]object{"interop-a-fixed-array-still-reaches-a-genuine-clr-array-parameter", `package P
import System
import Interop

struct Foo { var X int32 }

func countFixed[T](first T, second T, third T) int32 {
    return ArrayProbes.CountAny[T]([3]T{first, second, third})
}

func main2() {
    Console.WriteLine(ArrayProbes.Count([3]int32{1, 2, 3}).ToString())
    Console.WriteLine(countFixed[int32](1, 2, 3).ToString())
    Console.WriteLine(countFixed[Foo](Foo{X: 1}, Foo{X: 2}, Foo{X: 3}).ToString())
}

main2()`, []string{"3", "3", "3"}}
            // A `List<int[]>` built on the C# side comes back with no length
            // anywhere in it, so its member slot stays the lenient reflected one —
            // the projection this PR adds fires only on a G#-native `[N]T`.
            yield[]object{"interop-a-metadata-recovered-list-keeps-its-length-free-member-slot", `package P
import System
import Interop

func main2() {
    var xs = ArrayProbes.MakeList()
    xs.Add([4]int32{1, 2, 3, 4})
    Console.WriteLine(xs.Count.ToString())
    Console.WriteLine(xs[1].Length.ToString())
}

main2()`, []string{"2", "4"}}
        }

        /// The row this file pinned as ACCEPTED residue — sub-case 3 — and #4024
        /// turned into an error. Kept here, flipped rather than deleted, so the
        /// change reads as deliberate.
        /// @remarks #4024 retained the SLICE spelling `[]T` as a symbolic generic type
        /// argument, via `TypeSymbol.ContainsSourceArrayShape` at #3962's four
        /// RETENTION gates in the binder. That is a different place from the two
        /// gates this file widened: a source-spelled `List[[]int32]` used to
        /// carry an EMPTY symbolic vector, which is exactly what a
        /// metadata-recovered `List<int[]>` carries, so
        /// `ContainsMetadataRecoveredArray` correctly kept the lenient CLR
        /// comparison and there was nothing to compare. #4024 also widened the
        /// #2735 guard in `Conversion.ClassifyCore`, which read `from`
        /// alone — sufficient only while every pair it stopped carried a fixed
        /// array on both sides. This file's own member-slot gates are UNCHANGED,
        /// and `a-fixed-array-still-widens-to-a-slice-type-argument` in
        /// (cref:UnchangedCases) is the running proof.
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
