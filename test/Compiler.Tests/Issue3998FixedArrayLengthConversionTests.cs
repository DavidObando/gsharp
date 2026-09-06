// <copyright file="Issue3998FixedArrayLengthConversionTests.cs" company="GSharp">
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
/// Issue #3998: a fixed-length array's declared LENGTH was not part of any
/// conversion, so <c>[3]int32</c> converted implicitly to <c>[4]int32</c>, and
/// <c>[]int32</c> converted implicitly to <c>[3]int32</c> — at the TOP level,
/// with no reflection, erasure or generic instantiation involved.
/// </summary>
/// <remarks>
/// <para><b>Where the length was lost.</b> <c>ArrayTypeSymbol</c> is backed by
/// the plain SZ-array <c>T[]</c> — the SAME <c>System.Type</c> as the slice
/// <c>[]T</c> and as an array of every other length. Two identity helpers
/// (<c>TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability</c> and
/// <c>Conversion.TryClassifyWrappedElementIdentity</c>) DO compare the length,
/// but neither ever rejects: they only decline to answer "identity", and the
/// pair then fell through to the general CLR reference-assignability arm
/// (issue #521), where <c>int32[]</c> is assignable from <c>int32[]</c>. The
/// #2516 invariance guard that stops CLR array covariance fired only when the
/// SOURCE was a <c>SliceTypeSymbol</c> or an <c>ImportedTypeSymbol(T[])</c>;
/// <c>from is ArrayTypeSymbol</c> was not guarded at all. In the other
/// direction the #528 and #1162 slice-source arms accepted any
/// <c>ArrayTypeSymbol</c> target, because a <c>[3]int32</c> target's
/// <c>ClrType</c> is the very <c>int32[]</c> they were matching.</para>
/// <para><b>The rule this file pins.</b> A fixed array's length is part of its
/// type. <c>[N]T</c> converts IMPLICITLY to <c>[]T</c> — dropping a known
/// length for an unknown one is a widening and a representation no-op, so a
/// fixed array still reaches every <c>[]T</c> slot. Nothing converts
/// implicitly INTO a <c>[N]T</c> except a <c>[N]T</c> of the same length.
/// Every rejected pair keeps its explicit <c>cast[…]</c>, exactly as slice
/// covariance does (<c>GS0156</c> points at it); the cast reinterprets and
/// does not change the value, so a <c>[3]int32</c> cast to <c>[4]int32</c>
/// still reports <c>.Length == 3</c>.</para>
/// <para><b>Two side effects of the same arm, measured rather than
/// asserted.</b> A fixed array whose element is a SAME-COMPILATION type used
/// to fail to widen at all (<c>[2]Foo -&gt; []Foo</c> reported
/// <c>GS0154</c>/<c>GS0156</c>), because the widening path existed only for an
/// element with a CLR type; the new arm compares elements symbolically and
/// closes that. And a COVARIANT element used to report <c>GS0155</c> — no
/// conversion at all, so <c>cast[[]Base](d)</c> did not compile either — and
/// now reports <c>GS0156</c> with a working cast, matching what
/// <c>[]Derived -&gt; []Base</c> has had since #2516. Element invariance for
/// IMPLICIT conversions is unchanged in both cases.</para>
/// <para><b>The line the fix does not cross.</b> An array recovered from
/// METADATA arrives as <c>ImportedTypeSymbol(T[])</c> and carries no length —
/// reflection never recorded one. Rejecting such a pair would break ordinary
/// interop, so the guard deliberately does not fire for an imported SZ-array
/// on either side. That is the same line #3924's
/// <c>IsMetadataRecoveredElement</c> and #3962's <c>interop-*</c> cases draw,
/// and the <c>interop-*</c> cases here draw it again.</para>
/// <para><b>Known residue, deliberately out of scope (tracked separately).</b>
/// The MEMBER surface of a generic over a fixed array still reflects the
/// length-free CLR shape: <c>List[[3]int32]</c> keeps <c>[3]int32</c> in its
/// symbolic <c>TypeArguments</c> (#3962 retained it), but <c>Add</c>'s
/// parameter is read off the closed <c>List&lt;int32[]&gt;</c> rather than
/// projected through that argument, so <c>xs.Add([4]int32{…})</c> is still
/// accepted. Measured, not assumed: widening
/// <c>ImportedTypeSymbol.HasSubstitutableTypeArgument</c> to include
/// <c>ContainsFixedLengthArray</c> — the mechanism #4002's hand-off predicted
/// — changes NEITHER this row NOR the <c>List[[N]UserType].Add</c>
/// unreachability, so that widening is not part of this PR. The
/// <c>residue-*</c> cases pin today's behaviour so the follow-up has to change
/// this file on purpose.</para>
/// </remarks>
public class Issue3998FixedArrayLengthConversionTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the interop cases link against. A genuine CLR
    /// <c>int[]</c> has no length in metadata, which is the whole point.
    /// </summary>
    private const string LibrarySource = """
        namespace Interop;

        public static class ArrayProbes
        {
            // A genuine `int[]` parameter: the CLR type a G# `[3]int32`
            // really has. A fixed array must keep reaching it.
            public static int Count(int[] items) => items.Length;

            // A genuine `int[]` return: metadata records no length at all, so
            // the comparison against a `[3]int32` slot must stay lenient
            // rather than reject on information nobody has.
            public static int[] Make() => new[] { 10, 20, 30 };
        }
        """;

    /// <summary>
    /// Pairs that must NO LONGER convert implicitly. Each is measured on
    /// <c>main</c> as an accepted program.
    /// </summary>
    /// <returns>Name, G# source, a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // Sub-case 1, the core of the issue: two declared lengths are two
        // types. Nothing here involves reflection, erasure, or a generic.
        yield return new object[]
        {
            "a-shorter-fixed-array-does-not-fill-a-longer-slot",
            """
            package P
            import System

            func main2() {
                var a3 [3]int32 = [3]int32{1, 2, 3}
                var a4 [4]int32 = a3
                Console.WriteLine(a4.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[3]int32' to '[4]int32'",
        };

        // The same rule at a G#-DECLARED parameter. This is the row #4002's
        // hand-off named: it owes nothing to reflection, so it is the honest
        // statement of the bare rule.
        yield return new object[]
        {
            "a-declared-fixed-array-parameter-rejects-another-length",
            """
            package P
            import System

            func take3(a [3]int32) int32 {
                return a[0]
            }

            func main2() {
                Console.WriteLine(take3([4]int32{1, 2, 3, 4}).ToString())
            }

            main2()
            """,
            "requires a value of type '[3]int32' but was given a value of type '[4]int32'",
        };

        // The return position takes the same rule as assignment.
        yield return new object[]
        {
            "a-fixed-array-return-rejects-another-length",
            """
            package P
            import System

            func returns3() [3]int32 {
                return [4]int32{1, 2, 3, 4}
            }

            func main2() {
                Console.WriteLine(returns3().Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[4]int32' to '[3]int32'",
        };

        // Sub-case 2 (bare half): a slice's length is unknown, so it cannot
        // silently satisfy a slot that declares one.
        yield return new object[]
        {
            "a-slice-does-not-implicitly-narrow-to-a-fixed-length",
            """
            package P
            import System

            func main2() {
                var s []int32 = []int32{1, 2, 3}
                var back [3]int32 = s
                Console.WriteLine(back.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[]int32' to '[3]int32'",
        };

        // Sub-case 3: the literal's own length against the declared slot.
        // This is not a separate rule — the literal binds as `[2]int32`
        // (ExpressionBinder.Literals builds `ArrayTypeSymbol.Get(element,
        // length)` from the WRITTEN length, never from the target) and then
        // takes sub-case 1's conversion. It was accepted with `lit.Length`
        // reporting 2 under a type that said 3.
        yield return new object[]
        {
            "a-literal-of-the-wrong-length-does-not-fill-a-declared-slot",
            """
            package P
            import System

            func main2() {
                var lit [3]int32 = [2]int32{1, 2}
                Console.WriteLine(lit.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[2]int32' to '[3]int32'",
        };

        // The same literal mismatch through a struct field initializer, so
        // the rule is a property of the conversion and not of `var`.
        yield return new object[]
        {
            "a-fixed-array-field-rejects-a-literal-of-another-length",
            """
            package P
            import System

            struct Holder {
                var Slot [3]int32
            }

            func main2() {
                var h = Holder{Slot: [2]int32{1, 2}}
                Console.WriteLine(h.Slot.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[2]int32' to '[3]int32'",
        };

        // A same-compilation element type reaches the symbolic arm (#1162)
        // rather than the CLR-backed one, and takes the same rule.
        yield return new object[]
        {
            "a-slice-of-a-same-compilation-element-does-not-narrow",
            """
            package P
            import System

            struct Foo {
                var X int32
            }

            func main2() {
                var s []Foo = []Foo{Foo{X: 1}, Foo{X: 2}}
                var fixed2 [2]Foo = s
                Console.WriteLine(fixed2.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[]Foo' to '[2]Foo'",
        };

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
        yield return new object[]
        {
            "a-covariant-element-is-explicit-only-not-implicit",
            """
            package P
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

            main2()
            """,
            "Cannot convert type '[2]Derived' to '[]Base'. An explicit conversion exists",
        };

        yield return new object[]
        {
            "a-covariant-element-is-explicit-only-at-a-matching-length",
            """
            package P
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

            main2()
            """,
            "Cannot convert type '[2]Derived' to '[2]Base'. An explicit conversion exists",
        };

        // A nullable annotation on the target does not smuggle the narrowing
        // back in: `[3]?int32` is a nullable REFERENCE to a length-3 array,
        // and nullable lifting peels the annotation before classification, so
        // the slice still meets the same rule.
        yield return new object[]
        {
            "a-nullable-fixed-array-target-does-not-accept-a-slice",
            """
            package P
            import System

            func main2() {
                var s []int32 = []int32{1, 2, 3}
                var x [3]?int32 = s
                Console.WriteLine(x!!.Length.ToString())
            }

            main2()
            """,
            "Cannot convert type '[]int32' to '[3]?int32'",
        };

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
        yield return new object[]
        {
            "a-homonym-element-is-not-the-same-element-at-a-matching-length",
            """
            package P
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

            main2()
            """,
            "Cannot convert type '[1]A.Item' to '[1]B.Item'",
        };

        yield return new object[]
        {
            "a-homonym-element-does-not-widen-to-another-containers-slice",
            """
            package P
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

            main2()
            """,
            "Cannot convert type '[1]A.Item' to '[]B.Item'",
        };

        yield return new object[]
        {
            "a-homonym-element-does-not-satisfy-a-declared-parameter",
            """
            package P
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

            main2()
            """,
            "requires a value of type '[1]B.Item' but was given a value of type '[1]A.Item'",
        };
    }

    /// <summary>
    /// Everything that must KEEP working: the widening direction, the whole
    /// surrounding array surface, and the explicit escape hatch. A fix that
    /// only stopped accepting things would pass the rejection theory and fail
    /// every one of these.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // `[N]T -> []T` is the direction that stays implicit, and the reason
        // the rule is stated as widening rather than as "the shapes must
        // match": rejecting it would strand every fixed array in front of
        // every `[]T` parameter with no escape but a cast.
        yield return new object[]
        {
            "a-fixed-array-still-widens-to-a-slice",
            """
            package P
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

            main2()
            """,
            new[] { "3", "3", "3" },
        };

        // The same widening with a same-compilation element, which takes the
        // symbolic arm rather than the CLR-backed one. This row was RED before
        // the fix and is red for the opposite reason: the widening path
        // existed only for an element with a CLR type, so `[2]Foo -> []Foo`
        // reported GS0154/GS0156 while `[2]int32 -> []int32` was implicit.
        // The new arm compares elements symbolically and closes that too.
        yield return new object[]
        {
            "a-fixed-array-of-a-same-compilation-element-still-widens",
            """
            package P
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

            main2()
            """,
            new[] { "2", "2" },
        };

        // The rest of a fixed array's conversion surface is element-based,
        // not shape-based, and the new guard must not intercept any of it:
        // `System.Array`, the array interfaces, `object`, and `for … in`.
        yield return new object[]
        {
            "the-surrounding-array-surface-is-untouched",
            """
            package P
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

            main2()
            """,
            new[] { "3", "3", "Int32[]", "6" },
        };

        // A matching length is still one type, in both spellings, and a
        // generic over a fixed array still round-trips through its members.
        yield return new object[]
        {
            "a-matching-length-is-still-one-type",
            """
            package P
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

            main2()
            """,
            new[] { "3", "9", "3" },
        };

        // GS0156 promises a cast, so the cast has to exist and verify. It
        // reinterprets rather than converts: the value keeps its own length,
        // which is exactly why the IMPLICIT conversion is the thing withdrawn.
        yield return new object[]
        {
            "the-explicit-cast-escape-hatch-still-works-both-ways",
            """
            package P
            import System

            func main2() {
                var s []int32 = []int32{1, 2, 3}
                var narrowed = cast[[3]int32](s)
                Console.WriteLine(narrowed.Length.ToString())

                var a3 = [3]int32{1, 2, 3}
                var widened = cast[[4]int32](a3)
                Console.WriteLine(widened.Length.ToString())
            }

            main2()
            """,
            new[] { "3", "3" },
        };

        // The cast promise has to hold for the symbolic (null-`ClrType`)
        // element and for the covariant element too, or the spec sentence
        // overclaims for exactly the cases the new arm added.
        yield return new object[]
        {
            "the-explicit-cast-covers-symbolic-and-covariant-elements-too",
            """
            package P
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

            main2()
            """,
            new[] { "2", "2", "2" },
        };

        // Review finding 2 (#4018): the cast the diagnostic and the spec
        // promise has to exist for a SAME-COMPILATION element too, and it
        // has to reach the emitter. `[3]Foo` and `[4]Foo` both have a null
        // `ClrType` while binding, so the CLR-keyed predicates could not see
        // that they share one runtime representation: the pair classified as
        // `None`, and once the binder was taught to answer from the symbols
        // the emitter had no arm either and raised `GS9998`. Both halves are
        // fixed, and the row asserts the point of the cast — it reinterprets
        // and does not change the value, so `.Length` is still 3.
        yield return new object[]
        {
            "the-explicit-cast-works-for-a-same-compilation-element-across-lengths",
            """
            package P
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

            main2()
            """,
            new[] { "3", "3", "9" },
        };

        // Slices are not collateral damage: slice-to-slice, slice literals,
        // and the growable `List[T]` shape are all unaffected.
        yield return new object[]
        {
            "ordinary-slice-conversions-are-unaffected",
            """
            package P
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

            main2()
            """,
            new[] { "2", "2", "2", "2" },
        };
    }

    /// <summary>
    /// Behaviour this PR deliberately does NOT change, pinned so the boundary
    /// is visible and a later fix has to update this file on purpose. Every
    /// one of these is a MEMBER slot whose type came back from reflection off
    /// the erased <c>List&lt;int32[]&gt;</c>/<c>Stack&lt;int32[]&gt;</c>
    /// rather than being projected through the receiver's retained
    /// <c>[3]int32</c>.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> ResidueCases()
    {
        // The `Add` half of #3962's `member-argument-length-follows-the-bare-
        // conversion-rule` pin. #4002 pinned it together with the `take3`
        // line so a fix here could not split them silently; this PR splits
        // them LOUDLY — `take3` is now a rejection row above, and this stays
        // accepted because `Add`'s parameter is `int32[]` from reflection,
        // not the `[3]int32` the receiver still carries.
        yield return new object[]
        {
            "residue-a-generic-members-parameter-still-reflects-the-erased-array",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var xs = List[[3]int32]()
                xs.Add([4]int32{5, 6, 7, 8})
                Console.WriteLine(xs.Count.ToString())
                Console.WriteLine(xs[0].Length.ToString())
            }

            main2()
            """,
            new[] { "1", "4" },
        };

        // `List[T]` also exposes the non-generic `IList.Add(object)`, which
        // would accept anything at all, so the row above is not proof on its
        // own. `Stack[T].Push(T)` has no such sibling: this is the member
        // projection gap by itself.
        yield return new object[]
        {
            "residue-a-member-with-no-object-overload-still-accepts-another-length",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var st = Stack[[3]int32]()
                st.Push([4]int32{1, 2, 3, 4})
                Console.WriteLine(st.Count.ToString())
                Console.WriteLine(st.Peek().Length.ToString())
            }

            main2()
            """,
            new[] { "1", "4" },
        };

        // #3962's `slice-argument-still-reaches-a-fixed-array-generic`,
        // unchanged. A SLICE type argument is erased to `T[]` by
        // `Binder.ProjectGenericArgument` before any comparison can see it —
        // a different mechanism from the member gap above, and the one #3962
        // declined because retaining it symbolically changes the
        // representation of every `List[[]T]` in the corpus.
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
    }

    /// <summary>
    /// The metadata-recovery line: a CLR <c>int[]</c> carries no length, so it
    /// keeps converting in both directions.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> InteropCases()
    {
        yield return new object[]
        {
            "interop-a-fixed-array-still-reaches-a-clr-array-parameter",
            """
            package P
            import System
            import Interop

            func main2() {
                Console.WriteLine(ArrayProbes.Count([3]int32{1, 2, 3}).ToString())
                Console.WriteLine(ArrayProbes.Count([5]int32{1, 2, 3, 4, 5}).ToString())
            }

            main2()
            """,
            new[] { "3", "5" },
        };

        yield return new object[]
        {
            "interop-a-clr-array-return-still-fills-a-fixed-array-slot",
            """
            package P
            import System
            import Interop

            func main2() {
                var a [3]int32 = ArrayProbes.Make()
                Console.WriteLine(a.Length.ToString())
                var s []int32 = ArrayProbes.Make()
                Console.WriteLine(s.Length.ToString())
            }

            main2()
            """,
            new[] { "3", "3" },
        };
    }

    /// <summary>
    /// A length mismatch is a different type and never reaches the emitter.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void ADifferentArrayShape_DoesNotConvertImplicitly(string name, string source, string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3998_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
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
    [MemberData(nameof(AcceptedCases))]
    [MemberData(nameof(ResidueCases))]
    public void ALegitimateArrayConversion_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3998_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_3998_interop_").FullName;
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
