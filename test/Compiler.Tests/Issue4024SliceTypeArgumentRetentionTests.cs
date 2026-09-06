// <copyright file="Issue4024SliceTypeArgumentRetentionTests.cs" company="GSharp">
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
/// Issue #4024: a SLICE type argument was erased to <c>T[]</c> before any
/// comparison could see it, so <c>List[[]int32]</c> converted to
/// <c>List[[3]int32]</c>. The last open sub-case of #4012.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> One SZ-array CLR type, <c>T[]</c>, backs both G#
/// array spellings — <c>[]T</c> and <c>[N]T</c> at every length. #3962 taught
/// <c>Binder.ProjectGenericArgument</c> and its three siblings to RETAIN a
/// <c>[N]T</c> type argument symbolically, so <c>List[[3]int32]</c> carries
/// <c>[3]int32</c> in its <c>TypeArguments</c>. It did not retain <c>[]T</c>,
/// so <c>List[[]int32]</c> carried an EMPTY symbolic vector — which is
/// precisely what a metadata-recovered <c>List&lt;int[]&gt;</c> looks like.
/// <c>TypeSymbol.ContainsMetadataRecoveredArray</c> therefore, correctly for
/// what it could see, declared the shape unknowable and kept the lenient CLR
/// comparison, and the two spellings converted freely. The slice's identity
/// was lost in the binder, not in <c>Conversion</c>: by classification time
/// there was nothing on the slice side left to compare.</para>
/// <para><b>The fix, and its boundary.</b>
/// <c>TypeSymbol.ContainsSourceArrayShape</c> is <c>ContainsFixedLengthArray</c>
/// widened to both spellings, and replaces it at the FOUR RETENTION gates only
/// (<c>Binder.ProjectGenericArgument</c>,
/// <c>ExpressionBinder.TryResolveClrConstructionTypeArgs</c>, the
/// fully-qualified construction path in <c>ExpressionBinder.Access</c>, and the
/// static-receiver closure in <c>ExpressionBinder.Access.Accessor</c>). The
/// COMPARISON predicates keep <c>ContainsFixedLengthArray</c>: a pair that
/// carries no fixed array anywhere has nothing to disagree about, and widening
/// them would change nothing but the reasoning. The member-slot projection
/// gates #4012 widened (<c>ConversionClassifier.TrySubstituteParameterTypeFromReceiver</c>'s
/// entry gate and exit filter) are also left alone: <c>[]T</c> to <c>T[]</c> is
/// a FAITHFUL projection, so a slice needs no symbolic rescue there — which is
/// why <c>List[[]int32]().Add([3]int32{…})</c>, #4012's own green row, still
/// binds unchanged.</para>
/// <para><b>Every site is load-bearing, by ablation.</b> Revert one site to
/// <c>ContainsFixedLengthArray</c>, rebuild, run this file:
/// <c>Binder.ProjectGenericArgument</c> 4 red;
/// <c>TryResolveClrConstructionTypeArgs</c> 6 red;
/// <c>ExpressionBinder.Access</c> generic-name resolution 1 red
/// (<c>a-qualified-slice-construction-does-not-reach-a-fixed-array-generic</c>,
/// covered by no other site); <c>ExpressionBinder.Access.Accessor</c> receiver
/// closure 1 red
/// (<c>a-static-slice-receiver-does-not-reach-a-fixed-array-generic</c>,
/// likewise); the #2735 guard widening 7 red. Nothing reverted: all green. The
/// two single-row gates are the ones that would otherwise have been inherited
/// on faith from #3962's gate-to-spelling mapping. The two review-finding-2
/// lines in <c>MemberLookup</c> were ablated the same way: each alone leaves
/// <c>a-generic-factory-return-over-a-slice-does-not-reach-a-fixed-array-generic</c>
/// accepted, and two further candidate sites written for it changed nothing
/// once those two were in place and were dropped.</para>
/// <para><b>The one-sided guard this exposed.</b> #2735's guard in
/// <c>Conversion.ClassifyCore</c> — the one that stops the CLR-assignability
/// fallback readmitting a pair the identity gate just declined — reads
/// <c>RequiresSymbolicTypeArgumentIdentity(from)</c> ALONE. That sufficed while
/// only <c>[N]T</c> was retained, because every pair it had to stop carried a
/// fixed array on BOTH sides. With <c>[]T</c> retained the pair can be
/// ASYMMETRIC: measured, <c>List[[3]int32]</c> to <c>List[[]int32]</c> was
/// rejected by retention alone, while the reported direction
/// <c>List[[]int32]</c> to <c>List[[3]int32]</c> — nothing length-bearing on
/// the <c>from</c> side — sailed straight past it into
/// <c>IsAssignableByName</c> and was still accepted. The guard now also asks
/// the established two-sided <c>IsRejectedFixedArrayShapeMismatch</c>, which is
/// shared with #3962's variance guard so the two cannot drift.</para>
/// <para><b>What retention does NOT change.</b> A
/// <c>SliceTypeSymbol</c> has a real, non-null <c>ClrType</c> and satisfies
/// none of the arms of <c>ImportedTypeSymbol.HasSubstitutableTypeArgument</c>,
/// so that property stays <see langword="false"/> for <c>List[[]T]</c> and the
/// member-projection sites reading it — parameters, INDEXERS and iteration —
/// see exactly what they saw before. Method RETURNS are the one exception, and
/// the review found it: <c>GetClrMethodReturnTypeSymbol</c> projects whenever
/// the symbolic vector is nonempty, without consulting
/// <c>HasSubstitutableTypeArgument</c>, so <c>Stack[[]int32]().Pop()</c> now
/// surfaces the retained <c>[]int32</c> instead of the erased <c>int32[]</c>
/// and no longer fills a <c>[3]int32</c> slot. That is a breaking change beyond
/// the generic-identity rule, it is pinned as
/// <c>a-slice-generics-method-return-follows-the-retained-slice</c>, and it is
/// kept rather than gated because the new answer is the one #3998's bare rule
/// requires. The indexer's unchanged behaviour is pinned beside it,
/// so the asymmetry is visible rather than implied.</para>
/// <para><b>The #1354 nullable-flags question, measured.</b> Retaining a
/// symbolic argument bypasses the <c>Binder</c> branch that attaches the DFS
/// nullable-flags array, because that branch runs only when NO symbolic
/// argument is kept. The set this PR newly routes off it is therefore: slices
/// carrying <b>no</b> nullable-reference annotation anywhere. A slice that DOES
/// carry one — <c>[]string?</c> — was ALREADY retained before this PR, because
/// <c>RequiresSymbolicProjection</c> includes
/// <c>ContainsReferenceNullableAnnotation</c> and that recurses into the
/// element. So nothing that had a <c>2</c> to lose changed sides. Confirmed by
/// dumping <c>GetCustomAttributesData</c> on the emitted parameters of a G#
/// library, on both sides of the fix: <c>List[[]string]</c> carries
/// <c>NullableAttribute([1 1 1])</c>, <c>List[[]string?]</c> carries
/// <c>([1 1 2])</c> and <c>List[string?]</c> carries <c>([1 2])</c> — the same
/// three before and after. <c>a-nullable-reference-element-inside-a-slice-survives</c>
/// is that same fact as a running program.</para>
/// <para>The metadata carve-out is untouched: a C# <c>List&lt;int[]&gt;</c>
/// still crosses into and out of BOTH G# spellings — see
/// <see cref="InteropCases"/>.</para>
/// <para><b>Blast radius, measured.</b> Every <c>.gs</c> file under
/// <c>samples/</c>, <c>src/Sdk/</c>, <c>bench/</c>, <c>e2etests/</c> and
/// <c>test-assets/</c> (180 files) compiled before and after with
/// byte-identical diagnostic output — re-measured after the review fixes, with
/// the same result.</para>
/// <para><b>Review feedback.</b> Four findings, all measured before acting.
/// Finding 2 (a generic factory RETURN still reaching a fixed-array generic)
/// and finding 4 (the imported object-LITERAL path regressing to GS0157) were
/// real and are fixed here, each with its own row; finding 4's fix also closed
/// two PRE-EXISTING siblings, measured red on the parent commit, where the same
/// literal path already swallowed <c>Box[[3]int32]{…}</c> (since #3962) and
/// <c>Box[(a int32, b string)]{…}</c> (since ADR-0172). Finding 3 was half
/// right and is the more important half: method returns DID move, indexers did
/// not, and both are now pinned. Finding 1 did not reproduce — the program it
/// names still compiles and runs, on the parent commit and here — but the
/// predicate it points at genuinely is satisfied by a pair whose target alone
/// bears an array, so the disjunct was narrowed to two-sided anyway and the
/// program kept as a row.</para>
/// </remarks>
public class Issue4024SliceTypeArgumentRetentionTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the interop cases link against. A genuine CLR
    /// <c>int[]</c> records no shape in metadata — neither a length nor
    /// "slice" — which is the line retention must not cross.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public static class Rows
        {
            // A `List<int[]>` PARAMETER. Both G# spellings must still reach
            // it: metadata has no shape to disagree with.
            public static int Count(List<int[]> rows) => rows.Count;

            // A `List<int[]>` RETURN, so the G# side receives a receiver that
            // came back from metadata with an empty symbolic vector.
            public static List<int[]> Make() => new() { new[] { 1, 2, 3 }, new[] { 4, 5 } };

            // A VARIANT interface position, which #3962's variance guard also
            // watches.
            public static int Sum(IEnumerable<int[]> rows)
            {
                var total = 0;
                foreach (var row in rows)
                {
                    total += row.Length;
                }

                return total;
            }
        }

        // Review finding 2: an imported GENERIC METHOD whose return MENTIONS
        // its type parameter inside a constructed generic. This is a different
        // route to the same erasure — the return type, not a construction.
        public static class Factory
        {
            public static List<T> Make<T>() => new List<T>();
        }

        // Review finding 4: an imported generic class with settable properties,
        // for the object-LITERAL form `Box[[]int32]{ Value: … }`.
        public class Box<T>
        {
            public T? Value { get; set; }

            public int Tag { get; set; }
        }
        """;

    /// <summary>
    /// The rows this issue fixes: a generic over <c>[]T</c> and a generic over
    /// <c>[N]T</c> are two types, in both directions and at every site that
    /// retains a type argument.
    /// </summary>
    /// <returns>Name, G# source, a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The reported repro, verbatim from the issue. The DECLARED-TYPE
        // retention site (`Binder.ProjectGenericArgument`) supplies the
        // `[3]int32` side; the construction site supplies the `[]int32` side;
        // and the widened #2735 guard is what stops the CLR-assignability
        // fallback from readmitting it. Removing any one of the three makes
        // this row green again.
        yield return new object[]
        {
            "a-slice-generic-does-not-reach-a-fixed-array-generic",
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
            "Cannot convert type 'System.Collections.Generic.List[[]int32]' to 'System.Collections.Generic.List[[3]int32]'",
        };

        // The MIRROR direction. Worth its own row: it was rejected by
        // retention alone, before the #2735 guard was widened, and that
        // asymmetry is exactly what revealed the one-sided guard. Both
        // directions must be refused, because `List` is invariant in `T` and
        // these are two distinct arguments — the same reason #3962 gives for
        // `[3]` against `[4]`.
        yield return new object[]
        {
            "a-fixed-array-generic-does-not-reach-a-slice-generic",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var f3 = List[[3]int32]()
                f3.Add([3]int32{1, 2, 3})
                var slice List[[]int32] = f3
                Console.WriteLine(slice.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type 'System.Collections.Generic.List[[3]int32]' to 'System.Collections.Generic.List[[]int32]'",
        };

        // At a PARAMETER rather than a declared local, so the diagnostic comes
        // from applicability (GS0154) rather than from assignment (GS0155).
        yield return new object[]
        {
            "a-slice-generic-does-not-fill-a-fixed-array-generic-parameter",
            """
            package P
            import System
            import System.Collections.Generic

            func take3(l List[[3]int32]) int32 {
                return l.Count
            }

            func main2() {
                var slice = List[[]int32]()
                slice.Add([]int32{1, 2, 3})
                Console.WriteLine(take3(slice).ToString())
            }

            main2()
            """,
            "requires a value of type 'System.Collections.Generic.List[[3]int32]' but was given a value of type 'System.Collections.Generic.List[[]int32]'",
        };

        // The mirror at a parameter, driven by the CONSTRUCTION retention site
        // (`TryResolveClrConstructionTypeArgs`) on the argument side — the
        // argument is a bare `List[[3]int32]()`, never assigned to a declared
        // local, so `Binder.ProjectGenericArgument` never sees it.
        yield return new object[]
        {
            "a-constructed-fixed-array-generic-does-not-fill-a-slice-generic-parameter",
            """
            package P
            import System
            import System.Collections.Generic

            func takeSliceList(l List[[]int32]) int32 {
                return l.Count
            }

            func main2() {
                Console.WriteLine(takeSliceList(List[[3]int32]()).ToString())
            }

            main2()
            """,
            "requires a value of type 'System.Collections.Generic.List[[]int32]' but was given a value of type 'System.Collections.Generic.List[[3]int32]'",
        };

        // NESTING. `ContainsSourceArrayShape` recurses exactly as
        // `ContainsFixedLengthArray` does, so the shape is seen at any depth.
        yield return new object[]
        {
            "a-nested-slice-generic-does-not-reach-a-nested-fixed-array-generic",
            """
            package P
            import System
            import System.Collections.Generic

            func takeNested(l List[List[[3]int32]]) int32 {
                return l.Count
            }

            func main2() {
                var outer = List[List[[]int32]]()
                Console.WriteLine(takeNested(outer).ToString())
            }

            main2()
            """,
            "List[System.Collections.Generic.List[[]int32]]",
        };

        // The shape may be nested inside ANOTHER array spelling — `[][]T`
        // against `[][3]T` — which the recursion also covers.
        yield return new object[]
        {
            "a-slice-of-slices-does-not-reach-a-slice-of-fixed-arrays",
            """
            package P
            import System
            import System.Collections.Generic

            func takeNestedArr(l List[[][3]int32]) int32 {
                return l.Count
            }

            func main2() {
                Console.WriteLine(takeNestedArr(List[[][]int32]()).ToString())
            }

            main2()
            """,
            "requires a value of type 'System.Collections.Generic.List[[][3]int32]' but was given a value of type 'System.Collections.Generic.List[[][]int32]'",
        };

        // A MULTI-ARGUMENT generic, where the array shape is only the second
        // argument — the gate is per-argument, not per-type.
        yield return new object[]
        {
            "a-slice-value-argument-does-not-reach-a-fixed-array-value-argument",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var m = Dictionary[string, []int32]()
                m["a"] = []int32{1, 2, 3}
                var fixedMap Dictionary[string, [3]int32] = m
                Console.WriteLine(fixedMap.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type 'System.Collections.Generic.Dictionary[string, []int32]' to 'System.Collections.Generic.Dictionary[string, [3]int32]'",
        };

        // The FULLY-QUALIFIED construction path
        // (`ExpressionBinder.Access` generic-name resolution) is its own
        // retention gate and needed its own widening — this row is green
        // without it, even with the other three in place.
        yield return new object[]
        {
            "a-qualified-slice-construction-does-not-reach-a-fixed-array-generic",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var fixed3 List[[3]int32] = System.Collections.Generic.List[[]int32]()
                Console.WriteLine(fixed3.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type 'System.Collections.Generic.List[[]int32]' to 'System.Collections.Generic.List[[3]int32]'",
        };

        // The STATIC-RECEIVER path
        // (`ExpressionBinder.Access.Accessor.TryCloseImportedGenericTypeReceiver`),
        // the fourth gate. Without its widening `EqualityComparer[[]int32].Default`
        // is exposed as a metadata-only `EqualityComparer<int32[]>` and rides
        // the metadata leniency into a `[3]int32` slot.
        yield return new object[]
        {
            "a-static-slice-receiver-does-not-reach-a-fixed-array-generic",
            """
            package P
            import System
            import System.Collections.Generic

            func takeCmp(c EqualityComparer[[3]int32]) int32 {
                return 1
            }

            func main2() {
                Console.WriteLine(takeCmp(EqualityComparer[[]int32].Default).ToString())
            }

            main2()
            """,
            "requires a value of type 'System.Collections.Generic.EqualityComparer[[3]int32]' but was given a value of type 'System.Collections.Generic.EqualityComparer[[]int32]'",
        };

        // VARIANCE does not readmit what identity rejects. #3962 drew this
        // line for two lengths; the same line now covers the two spellings,
        // through the same shared `IsRejectedFixedArrayShapeMismatch`
        // predicate. Note this is deliberately NOT parity with the BARE
        // conversion, where `[3]int32` to `[]int32` is implicit (see the
        // `bare-fixed-array-still-widens-to-a-slice` control): a generic's
        // type argument is matched by identity, not by convertibility.
        yield return new object[]
        {
            "a-slice-generic-does-not-reach-a-variant-fixed-array-interface",
            """
            package P
            import System
            import System.Collections.Generic

            func takeSeq(s IEnumerable[[3]int32]) int32 {
                return 1
            }

            func main2() {
                var slice = List[[]int32]()
                Console.WriteLine(takeSeq(slice).ToString())
            }

            main2()
            """,
            "requires a value of type 'System.Collections.Generic.IEnumerable[[3]int32]'",
        };

        // The variance row that actually decides something. The row above is
        // the EASY direction — slice to fixed, which the bare rule refuses too.
        // THIS one is fixed to slice through a COVARIANT, read-only interface,
        // where the bare conversion IS implicit (`[3]int32` widens to
        // `[]int32`) and C#-style variance would therefore accept it.
        // Measured: refused, and that is the deliberate answer. A generic's
        // type argument is matched by IDENTITY, not by convertibility — the
        // same line #3962 drew when it refused `IEnumerable[[3]int32]` to
        // `IEnumerable[[4]int32]`, and the same shared
        // `IsRejectedFixedArrayShapeMismatch` predicate draws it. Both docs
        // state this rule explicitly; this row is what makes the statement
        // true.
        yield return new object[]
        {
            "a-fixed-array-generic-does-not-reach-a-variant-slice-interface",
            """
            package P
            import System
            import System.Collections.Generic

            func takeSliceSeq(s IEnumerable[[]int32]) int32 {
                return 1
            }

            func main2() {
                var f3 = List[[3]int32]()
                Console.WriteLine(takeSliceSeq(f3).ToString())
            }

            main2()
            """,
            "requires a value of type 'System.Collections.Generic.IEnumerable[[]int32]' but was given a value of type 'System.Collections.Generic.List[[3]int32]'",
        };

        // REVIEW FINDING 3, and the one BREAKING CHANGE this PR makes beyond
        // the generic-identity rule it set out to make. A generic's METHOD
        // RETURN does follow the retained argument: `Stack[[]int32]().Pop()`
        // used to surface the metadata `int32[]`, whose shape is unknowable and
        // therefore converts to anything, and now surfaces the retained
        // `[]int32`. Assigning that to a `[3]int32` moves from ACCEPTED to
        // REJECTED — measured on `main` (compiles, prints `3`) and here.
        //
        // Kept rather than gated, because the new answer is the CORRECT one:
        // #3998's bare rule is that nothing converts implicitly INTO a `[N]T`
        // except a `[N]T` of the same length, and `[]int32` is not one. The
        // old acceptance was the metadata carve-out firing on a type that only
        // looked metadata-recovered because the slice had been erased. The
        // explicit `cast[[3]int32](…)` remains, exactly as at the bare level.
        //
        // The PR's original boundary sentence claimed member returns were
        // byte-for-byte unchanged. That was wrong, and this row is the
        // correction. Note what did NOT move with it: the INDEXER — see
        // `a-slice-generics-indexer-still-surfaces-the-erased-element` in
        // <see cref="AcceptedCases"/>.
        yield return new object[]
        {
            "a-slice-generics-method-return-follows-the-retained-slice",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var st = Stack[[]int32]()
                st.Push([]int32{1, 2, 3})
                var popped [3]int32 = st.Pop()
                Console.WriteLine(popped.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[]int32' to '[3]int32'",
        };
    }

    /// <summary>
    /// Review finding 2: the same erasure reached through an imported generic
    /// method's constructed RETURN rather than through a construction. Needs
    /// the C# library, so it has its own rejection theory.
    /// </summary>
    /// <returns>Name, G# source, a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedInteropCases()
    {
        // Measured accepted on `main` AND on this PR's first revision: the
        // retention gates cover CONSTRUCTIONS, and a generic factory return
        // takes a different route. `BuildSymbolicMethodTypeArgs` dropped the
        // symbolic vector before `ResolveCallReturnTypeFromSymbolicTypeArgs`
        // could see it, so the call fell back to the closed CLR return
        // `List<int[]>` — which carries no symbolic vector and is therefore
        // indistinguishable from a metadata-recovered list, so the leniency
        // carve-out let it fill a `List[[3]int32]` slot. Exactly this issue's
        // hole, one route over.
        yield return new object[]
        {
            "a-generic-factory-return-over-a-slice-does-not-reach-a-fixed-array-generic",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var x List[[3]int32] = Factory.Make[[]int32]()
                Console.WriteLine(x.Count.ToString())
            }

            main2()
            """,
            "Cannot convert type 'System.Collections.Generic.List[[]int32]' to 'System.Collections.Generic.List[[3]int32]'",
        };
    }

    /// <summary>
    /// Legitimate uses of a generic over a slice. <c>[]T</c> is far commoner in
    /// real G# than <c>[N]T</c>, so this side of the witness carries more
    /// weight than in any sibling PR: every row moves a value through the
    /// instantiation and asserts its own stdout, so a "fix" that merely stopped
    /// accepting things fails all of them.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The base case: one spelling is one type, assignable to itself and
        // usable through a parameter, with the element still a slice.
        yield return new object[]
        {
            "a-slice-generic-is-one-type",
            """
            package P
            import System
            import System.Collections.Generic

            func takeSlices(l List[[]int32]) int32 {
                return l[0].Length
            }

            func main2() {
                var slice = List[[]int32]()
                slice.Add([]int32{1, 2, 3, 4})
                var same List[[]int32] = slice
                Console.WriteLine(same.Count.ToString())
                Console.WriteLine(takeSlices(same).ToString())
            }

            main2()
            """,
            new[] { "1", "4" },
        };

        // MEMBER PROJECTION is unchanged, which is the boundary this PR draws.
        // `TryGetValue`'s `out` slot, the indexer, and `Count` all come back
        // exactly as they did before retention, because
        // `HasSubstitutableTypeArgument` is still false for `List[[]T]`.
        yield return new object[]
        {
            "a-slice-value-argument-keeps-its-member-slots",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var m = Dictionary[string, []int32]()
                m["a"] = []int32{1, 2, 3}
                var found []int32 = []int32{}
                if m.TryGetValue("a", out found) {
                    Console.WriteLine(found.Length.ToString())
                }

                var same Dictionary[string, []int32] = m
                Console.WriteLine(same.Count.ToString())
            }

            main2()
            """,
            new[] { "3", "1" },
        };

        // GENERIC-METHOD INFERENCE against a receiver that now carries a
        // symbolic vector where it carried none: `ToArray`, a LINQ `Select`
        // over a `[]int32` lambda parameter, and the copy CONSTRUCTOR
        // `List[[]int32](IEnumerable[[]int32])`.
        yield return new object[]
        {
            "inference-still-works-against-a-retained-slice-receiver",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            func main2() {
                var rows = List[[]int32]()
                rows.Add([]int32{1, 2, 3})
                rows.Add([]int32{4, 5})

                var arr = rows.ToArray()
                Console.WriteLine(arr.Length.ToString())

                var lengths = rows.Select(func(r []int32) int32 { return r.Length })
                Console.WriteLine(lengths.Sum().ToString())

                var copy = List[[]int32](rows)
                Console.WriteLine(copy.Count.ToString())
            }

            main2()
            """,
            new[] { "2", "5", "2" },
        };

        // A SAME-COMPILATION generic over a slice, whose own CLR type is still
        // being built while conversions run. This is the shape a projection
        // reaching a CONSTRAINT would break; it round-trips through a field and
        // two methods.
        yield return new object[]
        {
            "a-same-compilation-generic-over-a-slice-round-trips",
            """
            package P
            import System
            import System.Collections.Generic

            class Box[T] {
                var value T

                func Set(v T) {
                    value = v
                }

                func Get() T {
                    return value
                }
            }

            func main2() {
                var b = Box[[]int32]()
                b.Set([]int32{1, 2, 3, 4, 5})
                var same Box[[]int32] = b
                Console.WriteLine(same.Get().Length.ToString())
            }

            main2()
            """,
            new[] { "5" },
        };

        // #4012's own green row, unchanged. A `[3]int32` still fills a
        // `List[[]int32]`'s `Add` slot, because `[]T` to `T[]` is a FAITHFUL
        // projection and the member-slot gates were deliberately left on
        // `ContainsFixedLengthArray`. This is the boundary, stated as a
        // running program: retention makes the two INSTANTIATIONS distinct
        // without touching what a member slot accepts.
        yield return new object[]
        {
            "a-fixed-array-still-fills-a-slice-generics-member-slot",
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

        // The #1354 answer, as a program. Note what this row does NOT prove:
        // `List[[]string?]` was ALREADY retained before this PR, because
        // `RequiresSymbolicProjection` includes
        // `ContainsReferenceNullableAnnotation`, which recurses into the
        // slice's element — so an annotated slice never went down the
        // nullable-flags branch in the first place, and this row is green on
        // both sides. That IS the answer to "what happens to those flags":
        // the arguments this PR newly diverts off that branch are the ones
        // with no annotation anywhere, for which it computed flags containing
        // no `2` and returned the bare symbol unchanged. Nothing with a `2` to
        // lose changed sides. Kept as a running row anyway, because it is the
        // sibling of #3962's `nullable-reference-element-inside-a-fixed-array`
        // and the pair reads as one rule.
        yield return new object[]
        {
            "a-nullable-reference-element-inside-a-slice-survives",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var l = List[[]string?]()
                l.Add([]string?{"a", nil})
                Console.WriteLine(l.Count.ToString())
                Console.WriteLine(l[0].Length.ToString())

                var plain = List[[]string]()
                plain.Add([]string{"x"})
                Console.WriteLine(plain[0][0])
            }

            main2()
            """,
            new[] { "1", "2", "x" },
        };

        // The static-receiver gate's own green row: retaining the argument
        // must not break the receiver it closes.
        yield return new object[]
        {
            "a-static-slice-receiver-still-works",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var cmp = EqualityComparer[[]int32].Default
                var a = []int32{1, 2, 3}
                Console.WriteLine(cmp.Equals(a, a).ToString())

                var same EqualityComparer[[]int32] = cmp
                Console.WriteLine(same.Equals(a, a).ToString())
            }

            main2()
            """,
            new[] { "True", "True" },
        };

        // ITERATION over the retained instantiation, with the element used as
        // a slice. `HasSubstitutableTypeArgument` gates the for-in enumerable
        // path, and it is still false here — this row proves that path did not
        // change under it.
        yield return new object[]
        {
            "iteration-over-a-slice-generic-still-yields-slices",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var slice = List[[]int32]()
                slice.Add([]int32{1, 2, 3})
                slice.Add([]int32{4, 5})
                var total = 0
                for row in slice {
                    total = total + row.Length
                }

                Console.WriteLine(total.ToString())
            }

            main2()
            """,
            new[] { "5" },
        };

        // COVARIANCE over the SAME argument still widens. The variance guard
        // rejects a shape MISMATCH, not variance itself.
        yield return new object[]
        {
            "a-slice-generic-still-widens-to-its-own-variant-interface",
            """
            package P
            import System
            import System.Collections.Generic

            func countSeq(s IEnumerable[[]int32]) int32 {
                var n = 0
                for row in s {
                    n = n + row.Length
                }

                return n
            }

            func main2() {
                var slice = List[[]int32]()
                slice.Add([]int32{1, 2, 3})
                slice.Add([]int32{4, 5})
                Console.WriteLine(countSeq(slice).ToString())
            }

            main2()
            """,
            new[] { "5" },
        };

        // A retained slice sitting BESIDE a constrained type parameter. A
        // projection that reaches a CONSTRAINT breaks constraint satisfaction
        // for the sibling type parameter — a failure this family has produced
        // before. `ContainsSourceArrayShape` is consulted only at the four
        // retention gates and never at a constraint check, so it structurally
        // cannot; this row is the running proof, and it exercises the
        // constrained member (`tag.Size()`, a `constrained. callvirt`) and the
        // slice payload on the same instantiation.
        yield return new object[]
        {
            "a-retained-slice-does-not-disturb-a-sibling-constraint",
            """
            package P
            import System
            import System.Collections.Generic

            interface Shaped {
                func Size() int32;
            }

            class Tag : Shaped {
                func Size() int32 {
                    return 7
                }
            }

            class Holder[T, U Shaped] {
                var payload T
                var tag U

                func Set(p T, t U) {
                    payload = p
                    tag = t
                }

                func Describe() int32 {
                    return tag.Size()
                }

                func Payload() T {
                    return payload
                }
            }

            func main2() {
                var h = Holder[[]int32, Tag]()
                h.Set([]int32{1, 2, 3}, Tag())
                Console.WriteLine(h.Describe().ToString())

                var same Holder[[]int32, Tag] = h
                Console.WriteLine(same.Payload().Length.ToString())
            }

            main2()
            """,
            new[] { "7", "3" },
        };

        // `ContainsSourceArrayShape` recurses through `GetWrappedTypes`, so a
        // slice buried under ANOTHER structural wrapper is newly retained too
        // — `List[map[string, []int32]]` was not retained before this PR and
        // is now. Nothing about that shape appears in the corpus, so it gets
        // its own row: a value moves all the way in and back out through the
        // map and the slice.
        yield return new object[]
        {
            "a-slice-nested-under-another-wrapper-round-trips",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var outer = List[map[string, []int32]]()
                var m = map[string, []int32]{}
                m["a"] = []int32{1, 2, 3}
                outer.Add(m)
                var same List[map[string, []int32]] = outer
                Console.WriteLine(same.Count.ToString())
                Console.WriteLine(same[0]["a"].Length.ToString())
            }

            main2()
            """,
            new[] { "1", "3" },
        };

        // REVIEW FINDING 3, the other half. The INDEXER did NOT move, and this
        // row pins that asymmetry rather than leaving it undocumented:
        // `List[[]int32]()[0]` still surfaces the erased `int32[]`, so it still
        // fills a `[3]int32` slot. `MapErasedIndexerElementType` consults
        // `HasSubstitutableTypeArgument`, which stays false for a retained
        // slice; `GetClrMethodReturnTypeSymbol` does not consult it, which is
        // why the METHOD return moved and this did not. So the boundary
        // sentence is true for parameters, indexers and iteration, and false
        // only for method returns. Filed as follow-up rather than closed here:
        // making the two agree is a member-surface change of #4012's kind, not
        // a type-identity one, and it belongs with a corpus measurement of its
        // own.
        yield return new object[]
        {
            "a-slice-generics-indexer-still-surfaces-the-erased-element",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var l = List[[]int32]()
                l.Add([]int32{1, 2, 3})
                var first [3]int32 = l[0]
                Console.WriteLine(first.Length.ToString())
            }

            main2()
            """,
            new[] { "3" },
        };

        // REVIEW FINDING 1. The concern was that
        // `IsRejectedFixedArrayShapeMismatch`, written for the variance call
        // site, would fire for `object` against `List[[3]int32]` at the new
        // #2735 call site and swallow a valid checked reference conversion. No
        // program was found that reaches it that way — an `object` source is
        // classified by an earlier arm — and this row is the measurement:
        // green on `main`, green before the hardening, green after it. The
        // disjunct is still narrowed to pairs where BOTH sides carry a G#
        // array spelling, so a future reordering of the arms above cannot make
        // the concern real.
        yield return new object[]
        {
            "a-checked-cast-from-object-to-a-fixed-array-generic-still-works",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var boxed object = List[[3]int32]()
                var back = cast[List[[3]int32]](boxed)
                Console.WriteLine(back.Count.ToString())
            }

            main2()
            """,
            new[] { "0" },
        };

        // The BARE rule is untouched, and it deliberately disagrees with the
        // generic one: at the top level `[3]int32` still widens implicitly to
        // `[]int32` (#3962 correction 1, pinned green in
        // `Issue3962GenericOverFixedArrayIdentityTests`). This PR changes what
        // a generic's TYPE ARGUMENT matches, not what a value converts to.
        yield return new object[]
        {
            "bare-fixed-array-still-widens-to-a-slice",
            """
            package P
            import System

            func main2() {
                var a3 [3]int32 = [3]int32{1, 2, 3}
                var s []int32 = a3
                Console.WriteLine(s.Length.ToString())
            }

            main2()
            """,
            new[] { "3" },
        };
    }

    /// <summary>
    /// The metadata carve-out, unchanged. A CLR <c>List&lt;int[]&gt;</c>
    /// records no shape at all, so it stays lenient in BOTH directions and
    /// against BOTH G# spellings — otherwise every C# API taking or returning
    /// an array-of-arrays would become unreachable.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> InteropCases()
    {
        // The SLICE spelling, both directions plus a variant interface. This
        // is the row retention could most easily have broken: the G# side now
        // carries a symbolic `[]int32` the C# side has no answer for.
        yield return new object[]
        {
            "interop-a-slice-generic-still-crosses-a-metadata-boundary",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var rows = List[[]int32]()
                rows.Add([]int32{1, 2, 3})
                rows.Add([]int32{4, 5})
                Console.WriteLine(Rows.Count(rows).ToString())
                Console.WriteLine(Rows.Sum(rows).ToString())

                var back List[[]int32] = Rows.Make()
                Console.WriteLine(back.Count.ToString())
                Console.WriteLine(back[0].Length.ToString())
            }

            main2()
            """,
            new[] { "2", "5", "2", "3" },
        };

        // The FIXED-ARRAY spelling against the same C# API, #3962's carve-out
        // re-measured under retention. Both spellings reach the one
        // `List<int[]>`, which is only consistent because neither the length
        // nor the slice-ness exists in metadata to disagree with.
        yield return new object[]
        {
            "interop-a-fixed-array-generic-still-crosses-a-metadata-boundary",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var fixedRows List[[3]int32] = Rows.Make()
                Console.WriteLine(fixedRows.Count.ToString())

                var f = List[[3]int32]()
                f.Add([3]int32{7, 8, 9})
                Console.WriteLine(Rows.Count(f).ToString())
            }

            main2()
            """,
            new[] { "2", "1" },
        };

        // Review finding 2's GREEN side: retaining the factory return must not
        // make the legitimate use unreachable. The matching spelling still
        // lands, and the element is still a slice on the way out.
        yield return new object[]
        {
            "a-generic-factory-return-over-a-slice-still-lands-in-its-own-spelling",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var ok List[[]int32] = Factory.Make[[]int32]()
                ok.Add([]int32{1, 2, 3})
                Console.WriteLine(ok.Count.ToString())
                Console.WriteLine(ok[0].Length.ToString())
            }

            main2()
            """,
            new[] { "1", "3" },
        };

        // REVIEW FINDING 4, the regression this PR's first revision
        // introduced: `TryResolveClrConstructionTypeArgs`' `hasSymbolicArgument`
        // flag is also read by the imported generic object-LITERAL path, which
        // treated it as a rejection. Making every slice symbolic therefore
        // turned this valid program into GS0157 "Cannot find type Box".
        yield return new object[]
        {
            "an-imported-generic-object-literal-over-a-slice-still-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var b = Box[[]int32]{ Value: []int32{1, 2, 3} }
                Console.WriteLine(b.Value.Length.ToString())
            }

            main2()
            """,
            new[] { "3" },
        };

        // The same literal path was ALREADY broken on `main` for the two other
        // families that retain a symbolic argument with a faithful CLR type —
        // `[N]T` since #3962, and a named tuple since ADR-0172. Both report
        // GS0157 there; measured. The fix keys on "has a real closed CLR type"
        // rather than on the retention flag, so it closes all three at once,
        // and these two rows are green here and red on the parent commit.
        yield return new object[]
        {
            "an-imported-generic-object-literal-over-a-fixed-array-now-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var b = Box[[3]int32]{ Value: [3]int32{1, 2, 3} }
                Console.WriteLine(b.Value.Length.ToString())
            }

            main2()
            """,
            new[] { "3" },
        };

        yield return new object[]
        {
            "an-imported-generic-object-literal-over-a-named-tuple-now-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var b = Box[(a int32, b string)]{ Tag: 5 }
                Console.WriteLine(b.Tag.ToString())
            }

            main2()
            """,
            new[] { "5" },
        };
    }

    /// <summary>
    /// A generic over <c>[]T</c> and a generic over <c>[N]T</c> are two types,
    /// and the diagnostic names both spellings.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void ASliceTypeArgument_DoesNotReachAFixedArrayGeneric(string name, string source, string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4024_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);

            // Nothing reached the emitter: this is a binding decision, and an
            // internal-compiler-error is not a rejection.
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The call must be refused on the SHAPE, not lost before overload
            // resolution ran — the failure mode #4012's sub-case 2 was about.
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every accepting case compiles, IL-verifies, runs, and prints what it
    /// claims — so a change that merely stopped accepting things fails here.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void ALegitimateSliceGeneric_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4024_").FullName;
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
    /// An array recovered from metadata has no shape to disagree with, so both
    /// G# spellings still cross the boundary in both directions.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(InteropCases))]
    public void AMetadataRecoveredArray_StaysLenient(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4024_interop_").FullName;
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
    /// The rejection rows that need the C# library — review finding 2's
    /// generic-factory return.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedInteropCases))]
    public void ASliceBearingImportedReturn_DoesNotReachAFixedArrayGeneric(
        string name,
        string source,
        string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4024_interop_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal);
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
