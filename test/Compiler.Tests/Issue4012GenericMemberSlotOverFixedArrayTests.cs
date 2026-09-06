// <copyright file="Issue4012GenericMemberSlotOverFixedArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4012: a generic's member slot over a fixed-length array was read
/// from the erased CLR shape rather than projected through the
/// <c>[N]T</c> the receiver still carries, and a <c>[N]T</c> argument over a
/// same-compilation element produced no effective CLR type at all.
/// </summary>
/// <remarks>
/// <para><b>Two sites, one family.</b> Both halves are the same sentence —
/// "a structural symbol is read through its CLR erasure" — but they fail in
/// different code and were measured apart.</para>
/// <para><b>Sub-case 1, the TARGET.</b>
/// <c>ConversionClassifier.TrySubstituteParameterTypeFromReceiver</c> is the
/// helper that rewrites an imported member's parameter through the receiver's
/// retained type arguments. Its entry gate admitted a type argument only when
/// <c>TypeSymbol.RequiresSymbolicProjection</c> said so or it was a tuple. A
/// <c>[3]int32</c> is neither — it has a perfectly real <c>int32[]</c>
/// <c>ClrType</c>, which is precisely the problem: that <c>ClrType</c> is
/// shared with <c>[]int32</c> and with an array of every other length. So the
/// helper bailed, <c>Add</c>'s parameter stayed the <c>int32[]</c> reflection
/// reports off the erased <c>List&lt;int32[]&gt;</c>, and
/// <c>List[[3]int32]().Add([4]int32{…})</c> was accepted with
/// <c>xs[0].Length == 4</c>. The exit filter needed the same widening or the
/// correctly recovered <c>[3]int32</c> was discarded again.</para>
/// <para><b>NOT <c>HasSubstitutableTypeArgument</c>.</b> #4002's hand-off
/// predicted that widening <c>ImportedTypeSymbol.HasSubstitutableTypeArgument</c>
/// would close this; #3998 applied the widening, measured it, and it changed
/// nothing. The ordinary imported instance-call path never consults that
/// property for parameter types. The gate that decides is the inline one in
/// <c>TrySubstituteParameterTypeFromReceiver</c>.</para>
/// <para><b>Sub-case 2, the ARGUMENT.</b>
/// <c>ExpressionBinder.GetEffectiveArgumentClrTypeForOverloadResolution</c>
/// rides an argument whose <c>ClrType</c> is null through to its ADR-0004
/// erasure so overload resolution can rank candidates. It had an arm for
/// <c>[]T</c> (#2182) and one for <c>[N,M]T</c>, and none for <c>[N]T</c>. A
/// <c>[3]Foo</c> over a same-compilation <c>Foo</c> therefore produced NO CLR
/// type, and every imported-call probe abandoned resolution before looking at
/// a candidate: <c>List[[3]Foo]().Add([3]Foo{…})</c> reported <c>GS0159
/// "Cannot find function Add"</c> while <c>List[[]Foo]().Add([]Foo{…})</c> and
/// <c>List[[3]int32]().Add([3]int32{…})</c> both bound. That is the "needs
/// BOTH a symbolic element and the fixed-array shape" signature the issue
/// reports; the declared length is not consulted by this arm at all.</para>
/// <para><b>Which CALL PATH, measured.</b> The INSTANCE-call path only.
/// <c>TryResolveAndBindClrInstanceCall</c> abandons the whole call when an
/// argument yields no effective CLR type, while a STATIC or EXTENSION imported
/// call has its own <c>MemberLookup.TryProjectErasedClrType</c> fallback
/// (#833 — the #3876 note inside
/// <c>GetEffectiveArgumentClrTypeForOverloadResolution</c> says exactly that
/// this is the one probe that already consulted it). So a <c>[3]T</c> reached
/// a static imported slot all along, and only member calls such as
/// <c>List[[3]Foo]().Add(…)</c> reported <c>GS0159</c>. The discriminating
/// rows for sub-case 2 are the four instance calls in
/// <see cref="NewlyAcceptedCases"/>, all red on the parent commit; the static
/// row in <see cref="InteropCases"/> is green there and is a must-not-change
/// row.</para>
/// <para><b>The leniency that had to be withdrawn.</b>
/// <c>BindClrParameterConversions</c> re-binds a CLR argument with
/// <c>allowExplicit: true</c>. With sub-case 1 fixed, the CLR-backed pair
/// (<c>[4]int32</c> at a projected <c>[3]int32</c>) never reaches that arm —
/// <c>NeedsBindClrParameterConversion</c> sees one <c>int32[]</c> on both
/// sides — and correctly reported <c>GS0156</c> from the #2391 arm, while the
/// same-compilation pair (<c>[4]Foo</c> at <c>[3]Foo</c>) DID reach it and was
/// silently accepted, because <c>[N]T -&gt; [M]T</c> is EXPLICIT by design
/// (#3998's cast reinterprets, it does not resize). The leniency is now
/// withdrawn for a <c>[N]T</c> target only, so both spellings agree.</para>
/// <para><b>Deliberately still out of scope: the SLICE half.</b>
/// <c>List[[]int32]</c> still converts to <c>List[[3]int32]</c>, because a
/// SLICE type argument is erased to <c>T[]</c> by
/// <c>Binder.ProjectGenericArgument</c> before any comparison can see it —
/// sub-case 3 of the issue, a different mechanism from either half here, and
/// the one #3962 declined because retaining it symbolically changes the
/// representation of every <c>List[[]T]</c> in the corpus and bypasses the
/// #1354 nullable-flags path. Filed as #4024, and pinned below and in the two
/// sibling files.</para>
/// </remarks>
public class Issue4012GenericMemberSlotOverFixedArrayTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the interop case links against. A genuine CLR
    /// <c>int[]</c> has no length in metadata, which is the whole point of the
    /// line this fix must not cross.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public static class ArrayProbes
        {
            // A genuine `int[]` parameter. A fixed array keeps reaching it:
            // metadata records no length to disagree with.
            public static int Count(int[] items) => items.Length;

            // A GENUINE `object[]` parameter — the shape a `[3]Foo` erases
            // to. Sub-case 2's arm makes `[N]Foo` present here exactly as
            // `[]Foo` already did; neither may reach it, and both are refused
            // by the same #3989 gate.
            public static int CountObjects(object[] items) => items.Length;

            // A generic slot whose element is inferred. `[N]T` must rank here
            // exactly as `[]T` does.
            public static int CountAny<T>(T[] items) => items.Length;

            // A `List<int[]>` built on the C# side, so the G# receiver comes
            // back from METADATA with no length anywhere in it.
            public static List<int[]> MakeList() => new() { new[] { 1, 2, 3 } };
        }
        """;

    /// <summary>
    /// The rows this issue fixes: a member slot on a generic over a
    /// fixed-length array now enforces the declared length.
    /// </summary>
    /// <returns>Name, G# source, a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // Sub-case 1, the reported row. `List[T]` also exposes the non-generic
        // `IList.Add(object)`, so this row alone is not proof — see the
        // `Stack` row below, which has no such sibling.
        yield return new object[]
        {
            "a-generic-member-slot-enforces-the-receivers-declared-length",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var xs = List[[3]int32]()
                xs.Add([4]int32{5, 6, 7, 8})
                Console.WriteLine(xs.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type '[4]int32' to '[3]int32'",
        };

        // `Stack[T].Push(T)` has no `object` sibling at all, so this isolates
        // the projection gap by itself. It is the row the issue named as the
        // one that proves the fix.
        yield return new object[]
        {
            "a-member-with-no-object-overload-enforces-the-declared-length",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var st = Stack[[3]int32]()
                st.Push([4]int32{1, 2, 3, 4})
                Console.WriteLine(st.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type '[4]int32' to '[3]int32'",
        };

        // The two halves compose. Sub-case 2's arm is what lets a `[N]Foo`
        // argument into overload resolution at all; sub-case 1's projection is
        // what makes the target `[3]Foo` once it is there. Before this PR the
        // outer call reported GS0159 and the length was never examined.
        yield return new object[]
        {
            "a-same-compilation-element-enforces-the-declared-length-too",
            """
            package P
            import System
            import System.Collections.Generic

            struct Foo { var X int32 }

            func main2() {
                var a = List[[3]Foo]()
                a.Add([4]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}, Foo{X: 4}})
                Console.WriteLine(a.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type '[4]Foo' to '[3]Foo'",
        };

        // The other direction of #3998's rule at the same projected slot:
        // nothing converts implicitly INTO a `[N]T` except a `[N]T` of the
        // same length, and an unknown length is not a matching one. Measured
        // as ACCEPTED before this PR — the erased `object[]` slot took it.
        yield return new object[]
        {
            "a-slice-argument-does-not-fill-a-projected-fixed-array-slot",
            """
            package P
            import System
            import System.Collections.Generic

            struct Foo { var X int32 }

            func main2() {
                var a = List[[3]Foo]()
                a.Add([]Foo{Foo{X: 1}})
                Console.WriteLine(a.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type '[]Foo' to '[3]Foo'",
        };

        // The same rule at a G#-DECLARED parameter, unchanged by this PR and
        // restated here as the control: the projected slot must agree with the
        // bare one, which is the whole claim of the fix.
        yield return new object[]
        {
            "control-a-declared-fixed-array-parameter-still-rejects-a-slice",
            """
            package P
            import System

            struct Foo { var X int32 }

            func takeFixed(v [3]Foo) int32 { return v.Length }

            func main2() {
                var s = []Foo{Foo{X: 1}}
                Console.WriteLine(takeFixed(s).ToString())
            }

            main2()
            """,
            "requires a value of type '[3]Foo'",
        };
    }

    /// <summary>
    /// Programs that were REFUSED before this PR and now compile, run and
    /// verify. Every one of them needed sub-case 2's argument ride-through.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> NewlyAcceptedCases()
    {
        // Sub-case 2, the reported row: `List[[N]Foo].Add` was unreachable.
        yield return new object[]
        {
            "a-fixed-array-over-a-same-compilation-element-reaches-a-generic-member",
            """
            package P
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

            main2()
            """,
            new[] { "1", "3", "2" },
        };

        // `Stack[T].Push(T)` again — no `object` sibling, so this is the
        // ride-through by itself rather than a lucky match on a wider slot.
        yield return new object[]
        {
            "a-fixed-array-over-a-user-struct-reaches-a-member-with-no-object-overload",
            """
            package P
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

            main2()
            """,
            new[] { "1", "3", "9" },
        };

        // The argument does not have to be a literal: a local of the same type
        // took the identical path and failed the identical way.
        yield return new object[]
        {
            "a-fixed-array-local-over-a-user-struct-reaches-a-generic-member",
            """
            package P
            import System
            import System.Collections.Generic

            struct Foo { var X int32 }

            func main2() {
                var a = List[[3]Foo]()
                var v = [3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}
                a.Add(v)
                Console.WriteLine(a.Count.ToString())
            }

            main2()
            """,
            new[] { "1" },
        };

        // An OPEN element is the other half of "no CLR identity". Inside a
        // generic function a `[3]T` argument had no effective CLR type either.
        yield return new object[]
        {
            "a-fixed-array-over-an-open-type-parameter-reaches-a-generic-member",
            """
            package P
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

            main2()
            """,
            new[] { "1", "1" },
        };
    }

    /// <summary>
    /// Programs that bound before this PR and must bind identically after it —
    /// the blast radius of both arms, stated as executable rows.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> UnchangedCases()
    {
        // The matching length still binds, now through the PROJECTED
        // `[3]int32` slot rather than the erased `int32[]` one.
        yield return new object[]
        {
            "a-matching-length-still-reaches-every-member-on-the-same-receiver",
            """
            package P
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

            main2()
            """,
            new[] { "2", "3", "9", "2", "4" },
        };

        // A fixed array still WIDENS to a slice at a generic member slot —
        // #3998's implicit direction, which the projection must not withdraw.
        yield return new object[]
        {
            "a-fixed-array-still-widens-to-a-slice-type-argument",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var a = List[[]int32]()
                a.Add([3]int32{1, 2, 3})
                Console.WriteLine(a.Count.ToString())
                Console.WriteLine(a[0].Length.ToString())
            }

            main2()
            """,
            new[] { "1", "3" },
        };

        // Sub-case 3, DELIBERATELY unchanged: a SLICE type argument is erased
        // to `T[]` by `Binder.ProjectGenericArgument` before any comparison
        // can see it, so `List[[]int32]` still reaches `List[[3]int32]`. The
        // matching pins live in `Issue3998FixedArrayLengthConversionTests`
        // (`residue-a-slice-type-argument-still-reaches-a-fixed-array-generic`)
        // and `Issue3962GenericOverFixedArrayIdentityTests`
        // (`slice-argument-still-reaches-a-fixed-array-generic`), and the gap
        // itself is filed as #4024.
        yield return new object[]
        {
            "residue-a-slice-type-argument-still-reaches-a-fixed-array-generic",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var slice = List[[]int32]()
                slice.Add([]int32{1, 2, 3})
                var fixed3 List[[3]int32] = slice
                Console.WriteLine(fixed3.Count.ToString())
            }

            main2()
            """,
            new[] { "1" },
        };

        // A tuple type argument on the same receiver still projects the way
        // #3560/#4000 left it — the widened gate is additive, not a rewrite.
        yield return new object[]
        {
            "a-tuple-type-argument-still-projects-on-the-same-gate",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var a = List[(int32, string)]()
                a.Add((1, "x"))
                Console.WriteLine(a.Count.ToString())
                Console.WriteLine(a[0].Item2)
            }

            main2()
            """,
            new[] { "1", "x" },
        };
    }

    /// <summary>
    /// The interop line: an array recovered from METADATA carries no length,
    /// so a fixed array keeps reaching it in both directions. Sub-case 2's
    /// widening must not change what a genuine CLR slot accepts.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> InteropCases()
    {
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
        yield return new object[]
        {
            "interop-a-fixed-array-still-reaches-a-genuine-clr-array-parameter",
            """
            package P
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

            main2()
            """,
            new[] { "3", "3", "3" },
        };

        // A `List<int[]>` built on the C# side comes back with no length
        // anywhere in it, so its member slot stays the lenient reflected one —
        // the projection this PR adds fires only on a G#-native `[N]T`.
        yield return new object[]
        {
            "interop-a-metadata-recovered-list-keeps-its-length-free-member-slot",
            """
            package P
            import System
            import Interop

            func main2() {
                var xs = ArrayProbes.MakeList()
                xs.Add([4]int32{1, 2, 3, 4})
                Console.WriteLine(xs.Count.ToString())
                Console.WriteLine(xs[1].Length.ToString())
            }

            main2()
            """,
            new[] { "2", "4" },
        };
    }

    /// <summary>
    /// A projected fixed-array slot rejects a different shape, and says so.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AProjectedFixedArraySlot_RejectsAnotherShape(string name, string source, string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4012_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The point of sub-case 2 is that these now fail on the LENGTH
            // rather than dead-ending before overload resolution ever ran.
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every accepting case compiles, IL-verifies, runs, and prints what it
    /// claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(NewlyAcceptedCases))]
    [MemberData(nameof(UnchangedCases))]
    public void ALegitimateMemberCall_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4012_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// An array that came back through reflection has no length to disagree
    /// with, so it keeps converting either way.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(InteropCases))]
    public void AMetadataRecoveredArray_StaysLenient(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4012_interop_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Issue #3989's gate is unaffected: a <c>[N]Foo</c> now presents as
    /// <c>object[]</c> to applicability exactly as a <c>[]Foo</c> already did,
    /// and a GENUINE <c>object[]</c> parameter still refuses both. Sub-case 2
    /// widens what reaches overload resolution, not what it accepts.
    /// </summary>
    [Fact]
    public void AFixedArrayOverAUserType_DoesNotReachAGenuineObjectArrayParameter()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4012_erased_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            const string Source = """
                package P
                import System
                import Interop

                struct Foo { var X int32 }

                func main2() {
                    Console.WriteLine(ArrayProbes.CountObjects([3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}).ToString())
                }

                main2()
                """;

            var appPath = Path.Combine(tempDir, "erased.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.False(File.Exists(appPath), $"a `[3]Foo` must not reach `object[]`. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The `[]Foo` control takes the same route and is refused the same
            // way, which is what "no better, no worse" means here.
            const string SliceControl = """
                package P
                import System
                import Interop

                struct Foo { var X int32 }

                func main2() {
                    Console.WriteLine(ArrayProbes.CountObjects([]Foo{Foo{X: 1}}).ToString())
                }

                main2()
                """;

            var controlPath = Path.Combine(tempDir, "erasedControl.dll");
            var controlLog = Compile(tempDir, "Control.gs", SliceControl, controlPath, "/target:exe", "/reference:" + libPath);
            Assert.False(File.Exists(controlPath), $"a `[]Foo` must not reach `object[]` either. Log:\n{controlLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] SplitLines(string output) => output
        .Split('\n')
        .Select(line => line.TrimEnd('\r'))
        .Where(line => line.Length > 0)
        .ToArray();

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Interop",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "Interop.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
