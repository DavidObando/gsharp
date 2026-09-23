// <copyright file="Adr0186PlatformTypeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsConversion = GSharp.Core.CodeAnalysis.Binding.Conversion;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 step 2, end to end: §3's conversions and generic-container rule,
/// §4's coercion check, §5's two-clause lookup invariant, and §6's operator
/// acceptance — all against <b>real csc-emitted oblivious metadata</b> rather
/// than synthesized symbols, because the whole design turns on what an
/// unannotated assembly actually says.
/// <para>
/// Every case runs in <b>both</b> modes. The <c>Enabled</c> column is not
/// decoration: ADR-0186's sequencing makes "no behaviour change while
/// <c>--nullability=platform-types</c> is off" the load-bearing claim of every
/// step before the default flips, and a test that only exercises the new mode
/// cannot see a regression in the old one.
/// </para>
/// </summary>
public sealed class Adr0186PlatformTypeBindingTests
{
    private const string Consumer = "Adr0186.Step2.Consumer";
    private const string Library = "Adr0186.Step2.Library";

    /// <summary>
    /// A nullability-<em>oblivious</em> library: no <c>[Nullable]</c> and no
    /// <c>[NullableContext]</c> reaches any member, so the flags array gsc
    /// reads is empty and every reference position is oblivious — ADR-0186
    /// §2's first table row, which is the only producer of <c>T!</c> that
    /// exists before §9.
    /// </summary>
    private const string LibrarySource = """
        #nullable disable
        using System;
        using System.Collections.Generic;

        namespace Adr0186.Step2.Library;

        public static class Ob
        {
            public static string Value() => "V";

            public static string Nil() => null;

            public static List<int> Numbers() => new List<int> { 1, 2, 3 };

            public static List<int> NilNumbers() => null;

            public static List<string> NilStrings() => null;

            // A non-nil `List<string>`, for probes about the CONTAINER's
            // element nullability rather than about the container being nil.
            public static List<string> Strings() => new List<string> { "a", null };

            public static Nested NilNest() => null;

            public static Nested Nest2() => new Nested();

            public static string[] ArrWithNil() => new string[] { null };

            public static string[] ArrField = new string[] { null };

            // A nil oblivious FIELD, so a chained read through it reaches
            // member lookup as an imported field-read receiver — the kind
            // `CanBindClrInstanceMember`'s deleted carve-out used to admit.
            public static Nested NilNestField = null;

            public static string[] NilArr() => null;

            public static Dictionary<string, string> TableWithNil()
                => new Dictionary<string, string> { { "k", null } };

            public static Exception NilException() => null;

            public static object NilLockTarget() => null;

            public static void TakesPlatform(string value)
                => Console.WriteLine(value == null ? "took nil" : value);

            public static Dictionary<string, int> Table() => new Dictionary<string, int> { { "k", 7 } };

            public static Queue<T> Wrap<T>(T value)
            {
                var queue = new Queue<T>();
                queue.Enqueue(value);
                return queue;
            }

            public static List<T> WrapList<T>(T value) => new List<T> { value };

            // Issue #4325's three positions need oblivious sources of their
            // own shapes: a delegate, a member-bearing object to compound-assign
            // through, and a deconstructible pair.
            public static Func<string> Thunk() => () => "V";

            public static Func<string> NilThunk() => null;

            public static Nested NilNested() => null;

            public static ValueTuple<string, string> Pair() => ("a", "b");

            // A REFERENCE deconstructible. `ValueTuple` is a struct, so it is
            // never nil and never platform-typed (ADR-0186 §2 excludes value
            // types) — a deconstruction-source check has nothing to bite on
            // there, and a fixture built only on `Pair()` would witness
            // nothing.
            public static Pt Pt2() => new Pt();

            public static Pt NilPt() => null;

            // Issue #4324's shape, as a value rather than a literal, so the
            // operand really is `string!` and not a constant.
            public static string Suffix() => "x";

            // Issue #4361: OPEN type-parameter slots in an unannotated
            // declaration — `Array.Empty<T>`, `Enumerable.Empty<T>`,
            // `Array.FindAll<T>` and FsCheck's `Arb.From<T>` shapes. The
            // element/argument nullability arrives with the type argument
            // (ADR-0186 §2); only the concrete container position is oblivious.
            public static T[] EmptyArr<T>() => new T[0];

            public static IEnumerable<T> EmptySeq<T>() => new T[0];

            public static T[] Same<T>(T[] values) => values;

            public static Holder<T> Hold<T>(T value) => new Holder<T> { Value = value };        }

        public class Holder<T>
        {
            public T Value;
        }

        public class Nested
        {
            public string Prop { get; set; } = "V";

            public int Num { get; set; }
        }

        public class Pt
        {
            public void Deconstruct(out string a, out string b)
            {
                a = "a";
                b = "b";
            }
        }

        #nullable enable

        // ADR-0186 §3 at an indexer PARAMETER. Annotated on purpose: an
        // oblivious `List<string>` parameter would project to the same
        // `List[string!]!` the argument already has, and a rule about two
        // DIFFERENT nullabilities cannot be witnessed by a pair that agrees.
        //
        // The set-only `int` indexer is the load-bearing part. Index
        // resolution only takes the symbolic path when some argument has no
        // `ClrType` or when the type has a set-only indexer, and a
        // `List[string!]!` argument always has a `ClrType` — so without this
        // member the access is resolved by reflection against the erased CLR
        // shape, where `List<string>` is `List<string>` and neither rule is
        // consulted at all. It is also what makes an empty applicable set
        // final rather than a fallback to that erased retry.
        public class ExactKeys
        {
            public string this[List<string> keys] => "exact";

            public int this[int slot] { set { } }
        }

        public class NilableKeys
        {
            public string this[List<string?> keys] => "nilable";

            public int this[int slot] { set { } }
        }

        // The same `List<string>` parameter, but now with a legal competitor.
        // Applicability and the later argument conversion are two different
        // steps, and only SELECTION can tell them apart: an over-accepted
        // `List[string]` candidate wins the ranking and takes the whole access
        // down with it, where rejecting it correctly leaves `object` to bind.
        public class NilableOrObjectKeys
        {
            public string this[List<string?> keys] => "nilable";

            public string this[object? any] => "object";

            public int this[int slot] { set { } }
        }

        public class OverloadedKeys
        {
            public string this[List<string> keys] => "exact";

            public string this[object any] => "object";

            public int this[int slot] { set { } }
        }

        // The discriminating fixture: an ANNOTATED-nullable property, i.e. a
        // member the author explicitly declared may be nil. It was one of the
        // two stated-nullable populations `CanBindClrInstanceMember`'s
        // `BoundClrPropertyAccessExpression` carve-out waved through unchecked
        // (the other is `Box<T>` below); ADR-0186 step 4 kept the carve-out
        // for it, and #4356 deleted it, so a chained read through it now
        // reports like any `T?`.
        public class Annotated
        {
            public List<int>? MaybeNumbers { get; set; } = new List<int> { 1, 2, 3 };

            public string? MaybeText { get; set; } = "v";
        }

        // The carve-out's other stated-nullable population: a plain generic `T` member whose
        // nullability comes from the RECEIVER's explicitly nullable type
        // argument (`Box[List[int32]?].Value` is `List[int32]?`), not from any
        // `[Nullable(2)]` on the declaration.
        public class Box<T>
        {
            public T Value { get; set; }

            public T Field;
        }
        """;

    /// <summary>
    /// <b>ADR-0186 §5a — the mutation witness, first half.</b>
    /// <para>
    /// This is the test the ADR names as required, and it witnesses the single
    /// most important property in the design: <em>a receiver's platform-ness
    /// cannot select a different member.</em> Failure mode 5 of the catalogue
    /// (commit <c>359538cd</c>) was a silent miscompile in which one source
    /// line, <c>xs.Reverse()</c>, bound <c>List&lt;T&gt;.Reverse</c> for a
    /// plain receiver (void, in place, first element becomes 3) and
    /// <c>Enumerable.Reverse</c> for a nilable one (lazy, copying, result
    /// discarded, first element stays 1) — same line, opposite runtime
    /// meaning, chosen purely by the receiver's static nullability, with no
    /// diagnostic either way.
    /// </para>
    /// <para>
    /// <b><c>import System.Linq</c> is load-bearing and deliberate.</b> Commit
    /// <c>359538cd</c> records why: without <c>Enumerable</c> in scope there
    /// is no competing extension, the test passes either way, and it witnesses
    /// nothing at all.
    /// </para>
    /// <para>
    /// The assertion is the <em>mutation</em>, observed by running the emitted
    /// assembly, because that is what distinguishes the two candidates —
    /// binding successfully proves nothing here, since both candidates bind.
    /// </para>
    /// </summary>
    [Fact]
    public void Section5a_APlatformReceiver_Selects_The_Same_Member_And_Produces_The_Same_Mutation()
    {
        const string body = """
                let xs = Ob.Numbers()
                xs.Reverse()
                Console.WriteLine(xs[0])
            """;

        // The `T` baseline: a G#-declared `List[int32]` receiver, which has
        // never been in any doubt.
        const string baseline = """
                let xs = List[int32]()
                xs.Add(1)
                xs.Add(2)
                xs.Add(3)
                xs.Reverse()
                Console.WriteLine(xs[0])
            """;

        using var world = new World();

        var baselineOutput = world.Run(baseline, NullabilityMode.Enabled);
        Assert.Equal("3", baselineOutput.Trim());

        // The witness: the SAME line against a platform receiver must produce
        // the same mutation. `Enumerable.Reverse` would print 1.
        var platformOutput = world.Run(body, NullabilityMode.PlatformTypes);
        Assert.Equal("3", platformOutput.Trim());

        // And the selection itself, asserted structurally rather than only
        // through its effect: the bound call names `List<T>.Reverse`, not
        // `Enumerable.Reverse`. A witness that only observed the mutation
        // would stay green if some future change made `Enumerable.Reverse`
        // mutate-and-return, which is exactly the kind of coincidence
        // ADR-0154 asks a witness not to rely on.
        Assert.Equal(
            world.SelectedReverseDeclaringType(baseline, NullabilityMode.Enabled),
            world.SelectedReverseDeclaringType(body, NullabilityMode.PlatformTypes));
    }

    /// <summary>
    /// <b>ADR-0186 §5b — the mutation witness, second half.</b>
    /// <para>
    /// §5's invariant has two clauses and the ADR is explicit that an earlier
    /// draft stated only the first: "a witness that checks only selection
    /// passes while §5b is broken." Selection constrains <em>which</em> member
    /// is chosen; it says nothing about <em>what type the expression has
    /// afterwards</em>.
    /// </para>
    /// <para>
    /// The named hazard: <c>MemberLookup.GetImportedTypeSymbol</c> is a closed
    /// switch over receiver type symbols with no <c>PlatformTypeSymbol</c>
    /// arm. Reached with one it falls through to the erased answer at each of
    /// its call sites, turning <c>Queue[Entry]!.Dequeue()</c> from
    /// <c>Entry</c> into a CLR erasure. The fix ADR-0186 prescribes — and
    /// which this test pins — is to unwrap <c>T!</c> to <c>T</c> <em>before</em>
    /// type resolution runs, on the path resolution already uses, rather than
    /// teaching each of the eleven consumers about the new wrapper.
    /// </para>
    /// <para>
    /// <c>Entry</c> is a <b>same-compilation G# class</b> on purpose. An
    /// imported element type survives erasure by accident (reflection resolves
    /// it anyway); a same-compilation type has no runtime <c>Type</c> during
    /// binding, so the erased path yields <c>object</c> and the symbolic path
    /// yields <c>Entry</c>. Only the same-compilation shape discriminates.
    /// </para>
    /// </summary>
    [Fact]
    public void Section5b_APlatformReceiver_Produces_The_Same_Result_Type_For_A_Symbolic_Call()
    {
        using var world = new World();

        // Baseline: the receiver is an ordinary `Queue[Entry]` built in G#.
        var baseline = world.GlobalProbeType(
            """
            let queue = Queue[Entry]()
            let probe = queue.Dequeue()
            """,
            NullabilityMode.Enabled);

        // Witness: the receiver is `Queue[Entry]!` — the oblivious library
        // returns it, so it arrives platform-wrapped.
        var platform = world.GlobalProbeType(
            """
            let probe = Ob.Wrap[Entry](Entry()).Dequeue()
            """,
            NullabilityMode.PlatformTypes);

        Assert.Equal("Entry", baseline.Name);

        // The load-bearing assertion. With §5b broken this reads "object".
        Assert.Equal(baseline.Name, platform.Name);
        Assert.DoesNotContain("object", platform.Name, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0186 §3 rule 3 — the generic-container soundness fix (Copilot
    /// finding HIGH-2 against the ADR), in both directions.
    /// <para>
    /// An earlier draft made <c>Box[string!]</c>, <c>Box[string]</c> and
    /// <c>Box[string?]</c> mutually assignable, reasoning that all three erase
    /// to one CLR type so nothing is observable at runtime. <b>Erasure is
    /// precisely what makes the hole reachable</b>: two views alias one
    /// object, so a nil written through one view is read as non-null through
    /// the other with <b>no <c>T! → T</c> boundary crossed anywhere</b> and
    /// therefore no §4 check.
    /// </para>
    /// <para>
    /// Exactly one conversion survives, <c>C[T!] → C[T?]</c>, and it is sound
    /// because every read through the destination view has type <c>T?</c> and
    /// must be narrowed before non-null use.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_AGenericContainer_Converts_Only_From_Platform_To_Nilable()
    {
        using var world = new World();

        // The source is a CONCRETE oblivious position: `Ob.NilStrings()`
        // returns `List<string>` from a `#nullable disable` scope, so both
        // the container and its element say nothing and it reads
        // `List[string!]!`. `Ob.WrapList[string]("x")` — what this test used
        // before — reaches the same shape by a different route and is kept
        // out of it on purpose: its `T` is an OPEN slot, and whether an open
        // slot is oblivious turns on whether the DECLARATION described it,
        // which is a distinct question with its own witness
        // (`ClrNullabilityTests.Adr0186_AnOpenSlot_TakesItsNullabilityFromTheArgument`).
        // A rule-3 test should not depend on that answer.

        // The unsound direction: a non-null read of a container that may hold
        // nil. This is the aliasing hole, and it must be a compile error.
        var toNonNull = world.Compile(
            """
                let alias List[string] = Ob.NilStrings()
                Console.WriteLine(alias[0])
            """,
            NullabilityMode.PlatformTypes);
        Assert.False(toNonNull.Success, Describe(toNonNull));
        // Issue #4361: the diagnostic names the nested `!` — before, both
        // sides printed as `List[string]` and the message read "Cannot convert
        // X to X".
        Assert.Contains(toNonNull.Diagnostics, d => d.Message.Contains("List[string!]!", StringComparison.Ordinal));

        // The one legal direction.
        var toNilable = world.Compile(
            """
                let alias List[string?] = Ob.NilStrings()
                Console.WriteLine(alias.Count)
            """,
            NullabilityMode.PlatformTypes);
        Assert.True(toNilable.Success, Describe(toNilable));

        // The two remaining unsound directions — `C[T] -> C[T!]` and
        // `C[T?] -> C[T!]` — have no source spelling to test here, because
        // `T!` is unwritable (§1) and no G# declaration can name a
        // platform-argument parameter before §9's oblivious scope lands. They
        // are pinned at the classifier instead, in
        // `Adr0186PlatformTypeConversionTests`, where both constructed types
        // can be built directly.
    }

    /// <summary>
    /// ADR-0186 §6: a guarded access yields a plain <c>U?</c>, never
    /// <c>U!?</c>.
    /// <para>
    /// When the accessed member is itself oblivious, the null-conditional
    /// result lifting was wrapping the platform type instead of its
    /// underlying, producing <c>Nullable(Platform(U))</c>. That is not a
    /// cosmetic difference: <c>U!?</c> is a nullable over a platform type,
    /// so platform-ness survived a guarded access and leaked into everything
    /// downstream — narrowing, <c>??</c>, <c>if let</c> — none of which
    /// expects to find a wrapper underneath the <c>?</c>.
    /// </para>
    /// <para>
    /// Fixed at <c>NullableTypeSymbol.Get</c> rather than at the three
    /// lifting sites that had the bug, because <c>T!?</c> is not a type this
    /// language has at all: by §3's governing principle an explicit
    /// statement beats the absence of one, which is the same rule that makes
    /// lub(<c>T!</c>, <c>T?</c>) be <c>T?</c>.
    /// </para>
    /// </summary>
    /// <param name="globals">A probe declaring <c>probe</c>.</param>
    [Theory]
    [InlineData("let probe = Ob.NilNest()?.Prop")]
    [InlineData("let probe = Ob.TableWithNil()?[\"k\"]")]
    public void Section6_AGuardedAccess_Yields_APlainNullable(string globals)
    {
        using var world = new World();

        var result = world.GlobalProbeType(globals, NullabilityMode.PlatformTypes);

        var nullable = Assert.IsType<NullableTypeSymbol>(result);
        Assert.Equal("string?", nullable.Name);
        Assert.IsNotType<PlatformTypeSymbol>(nullable.UnderlyingType);
    }

    /// <summary>
    /// ADR-0186 §6: the result of <c>??</c> over a platform left operand is
    /// the non-null underlying, not <c>T!</c>.
    /// <para>
    /// Supplying a fallback is precisely the act that removes the doubt, so a
    /// result still typed <c>T!</c> claims the compiler does not know
    /// something the expression has just guaranteed — and drags a spurious
    /// <c>T! -&gt; T</c> check, plus §3's overload tie-break, into every use
    /// downstream of it.
    /// </para>
    /// </summary>
    [Fact]
    public void Section6_Coalescing_APlatformOperand_Yields_TheNonNullUnderlying()
    {
        using var world = new World();

        var result = world.GlobalProbeType(
            "let probe = Ob.Value() ?? \"fallback\"",
            NullabilityMode.PlatformTypes);

        Assert.IsNotType<PlatformTypeSymbol>(result);
        Assert.IsNotType<NullableTypeSymbol>(result);
        Assert.Equal("string", result.Name);
    }

    /// <summary>
    /// ADR-0186 §4 inside an expression-tree lambda: a <b>receiver</b> check
    /// is elided, and every other platform coercion is still rejected.
    /// <para>
    /// §4 names the elision itself: "The CLR's own check on a
    /// <c>callvirt</c>/<c>ldfld</c> receiver makes the inserted check
    /// redundant where it fires, which is a reason to <b>elide</b> it as an
    /// optimization." Inside an expression-tree lambda gsc emits no IL — the
    /// access becomes <c>Expression.Property</c> or a call node — and
    /// <c>System.Linq.Expressions</c> dereferences the instance when the tree
    /// is evaluated, throwing at the same point. The failure survives; only
    /// G#'s message is lost, which is the residual tracked as <b>#4352</b>.
    /// </para>
    /// <para>
    /// <b>This is the narrow half of a change review was right to push back
    /// on.</b> Step 3 first removed the rejection outright, which silently
    /// dropped checks §4 and the release note both promise. What forced the
    /// question is that rejecting <em>receivers</em> is a build break on
    /// ordinary code: any oblivious reference member touched inside a
    /// LINQ-to-<c>IQueryable</c> lambda inserts one, so
    /// <c>Issue2661ExpressionTreeNullablePipelineTests</c>' <c>.Where(b -&gt;
    /// b.Conversion.AccountId == id)</c> stopped compiling the moment the
    /// default flipped. Eliding a receiver check is also not a regression:
    /// under ADR-0136 that receiver is <c>T?</c>, cs2gs writes an explicit
    /// <c>!!</c>, and the same lowering erases it.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    [Theory]

    // A member-access receiver: elided, because the tree dereferences it.
    // The member read is `int32` on purpose — a `string!` result would be a
    // second, NON-receiver coercion at the lambda's return, and this row is
    // about the receiver alone.
    [InlineData("    let e Expression[Func[int32]] = () -> Ob.Nest2().Num\n    Console.WriteLine(e)")]

    // The same receiver whose member read IS platform-typed, bound into a
    // nilable result so the read needs no coercion of its own.
    [InlineData("    let e Expression[Func[string?]] = () -> Ob.Nest2().Prop\n    Console.WriteLine(e)")]

    // A call receiver, the same shape one node over.
    [InlineData("    let e Expression[Func[int32]] = () -> Ob.WrapList(\"a\").Count\n    Console.WriteLine(e)")]
    public void Section4_APlatformReceiverCheck_InsideAnExpressionTreeLambda_Is_Elided(string body)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes, extraDeclarations: string.Empty);

        Assert.True(compiled.Success, Describe(compiled));
        Assert.DoesNotContain(compiled.Diagnostics, d => d.Id == "GS0473");
    }

    /// <summary>
    /// The other half, and the control that keeps the elision above honest: a
    /// platform coercion inside an expression-tree lambda that is <b>not</b> a
    /// receiver is still <c>GS0473</c>.
    /// <para>
    /// Nothing dereferences a lambda's own result, so erasing the check there
    /// would lose the failure entirely rather than merely its message —
    /// exactly what §4 forbids and what review objected to.
    /// <c>System.Linq.Expressions</c> has no throw-on-nil-and-yield form that
    /// preserves G#'s contract <em>and</em> survives translation by a real
    /// <c>IQueryable</c> provider, so rejection remains the honest answer
    /// until #4352 chooses one.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="site">What the row covers.</param>
    [Theory]

    // The lambda's own result, coerced to a non-null `string`.
    [InlineData(
        "    let e Expression[Func[string]] = () -> Ob.Value()!!\n    Console.WriteLine(e)",
        "an explicit '!!' on the result")]

    // An argument position inside the tree.
    [InlineData(
        "    let e Expression[Func[int32]] = () -> Ob.Value().Length\n    let f Expression[Func[string]] = () -> string.Concat(Ob.Value()!!, \"x\")\n    Console.WriteLine(f)",
        "an argument to a non-null parameter")]
    public void Section4_ANonReceiverPlatformCoercion_InAnExpressionTreeLambda_Is_Rejected(
        string body,
        string site)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes, extraDeclarations: string.Empty);

        Assert.False(compiled.Success, site + ": " + Describe(compiled));
        Assert.Contains(
            compiled.Diagnostics,
            d => d.Id == "GS0473"
                && d.Message.Contains("nullability-oblivious", StringComparison.Ordinal));
    }

    /// <summary>
    /// The second control: the validator's <em>other</em> rejection — a
    /// <c>!!</c> stripping a nullable VALUE type (issue #3349) — is untouched.
    /// <c>T? → T</c> over a value type is a real CLR conversion with no
    /// <c>System.Linq.Expressions</c> counterpart preserving G#'s
    /// throw-on-nil contract, and ADR-0186 §2 excludes value types entirely.
    /// </summary>
    [Fact]
    public void Section4_ANullableValueTypeAssertion_InAnExpressionTreeLambda_Is_Still_Rejected()
    {
        using var world = new World();

        var compiled = world.Compile(
            "    let n int32? = 1\n    let e Expression[Func[int32]] = () -> n!!\n    Console.WriteLine(e)",
            NullabilityMode.PlatformTypes,
            extraDeclarations: string.Empty);

        Assert.False(compiled.Success, Describe(compiled));
        Assert.Contains(compiled.Diagnostics, d => d.Id == "GS0473");
    }

    /// <summary>
    /// ADR-0186 §3 rule 3, for <b>magic collections</b> — the shape the first
    /// version of the container arm missed entirely, and the one place this
    /// step was measurably <em>worse</em> than the model it replaces.
    /// <para>
    /// An oblivious <c>string[]</c> arrives as <c>[]string!</c>: the wrapper
    /// sits on the container and the element's obliviousness lives in the
    /// reader's nullable-flags subtree, where rule 5 makes a read yield
    /// <c>string!</c> (pinned below). Assigning it into a bare
    /// <c>[]string</c> is therefore <c>C[T!] -&gt; C[T]</c> in substance, and
    /// rule 3 gives that no conversion.
    /// </para>
    /// <para>
    /// <b>Before the fix this compiled with no check at all.</b> The
    /// container check fired and passed — the array is not nil — and the
    /// conversion then erased the element's platform-ness, so
    /// <c>b[0].Length</c> threw an unattributed <c>NullReferenceException</c>
    /// on a program the pre-ADR-0186 model <em>rejects</em>. Incompleteness
    /// in a new rule turning into a strictness regression is the worst
    /// available outcome, and it is why this fixture exists separately from
    /// the generic-container one.
    /// </para>
    /// <para>
    /// Rejection, not a check, is the fix: rule 3 says the conversion does
    /// not exist, and rejecting restores parity with the current model.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="site">What the row covers.</param>
    [Theory]
    [InlineData("    let a = Ob.ArrWithNil()\n    let b []string = a\n    Console.WriteLine(b[0].Length)", "through an inferred local")]
    [InlineData("    let b []string = Ob.ArrWithNil()\n    Console.WriteLine(b[0].Length)", "directly at the declared slot")]
    [InlineData("    let b []string = Ob.NilArr()\n    Console.WriteLine(b.Length)", "with a nil container too - rule 3 does not care")]
    public void Section3_AMagicCollection_Is_Not_Exempt_From_The_Container_Rule(string body, string site)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);

        Assert.False(compiled.Success, site + ": " + Describe(compiled));

        // A platform array OF platform elements, in ADR-0132's positional
        // spelling (issue #4361's display fix — it used to print `[]string!`,
        // which is the spelling of a plain slice of platform elements).
        Assert.Contains(
            compiled.Diagnostics,
            d => d.Message.Contains("[]!string!", StringComparison.Ordinal));
    }

    /// <summary>
    /// The negative control for the fixture above, and the constraint that
    /// makes it safe: a pair the container rule cannot compare is
    /// <b>declined</b>, never rejected. Widening a platform slice to
    /// <c>object</c> or to a covariant sequence is an ordinary upcast and has
    /// nothing to do with rule 3 — an implementation that answered "illegal"
    /// for every uncomparable pair would break both.
    /// </summary>
    /// <param name="body">The probe body.</param>
    [Theory]
    [InlineData("    let o object = Ob.ArrWithNil()\n    Console.WriteLine(o)")]
    [InlineData("    let s sequence[string] = Ob.ArrWithNil()\n    Console.WriteLine(s)")]
    public void Section3_AnUncomparablePair_Is_Declined_Not_Rejected(string body)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);

        Assert.True(compiled.Success, Describe(compiled));
    }

    /// <summary>
    /// Rule 5 for a magic collection, and the fact the rule-3 fixture above
    /// rests on: an element read through a <c>[]string!</c> receiver is
    /// <c>string!</c>, so it is checked at its own coercion point rather than
    /// being silently non-null.
    /// </summary>
    [Fact]
    public void Section3_AnElementReadThroughAPlatformCollection_Is_Itself_Platform()
    {
        using var world = new World();

        var element = world.GlobalProbeType("let probe = Ob.ArrWithNil()[0]", NullabilityMode.PlatformTypes);

        Assert.IsType<PlatformTypeSymbol>(element);
        Assert.Equal("string!", element.Name);
    }

    /// <summary>
    /// ADR-0186 §4: the check actually fires, at runtime, with an attributable
    /// message — and it fires at the <b>upcast</b>, which is Copilot finding
    /// HIGH-1's shape (<c>object o = obliviousCall()</c>).
    /// <para>
    /// Asserting the throw rather than the emitted opcodes is deliberate.
    /// §4's justification is not "some IL exists" but "the failure is
    /// attributable at the boundary where the CLR offers nothing", and only
    /// running it shows that the check is reached, the exception type is the
    /// one existing <c>catch</c> clauses expect, and the message names the
    /// expression.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("    let s string = Ob.Nil()\n    Console.WriteLine(s)", "a declared non-null local")]
    [InlineData("    let s object = Ob.Nil()\n    Console.WriteLine(s)", "an upcast to object (HIGH-1)")]
    [InlineData("    takesString(Ob.Nil())", "an argument to a non-null parameter")]
    [InlineData("    Console.WriteLine(returnsString())", "a return from a non-null function")]
    [InlineData("    Console.WriteLine(Ob.Nil().Length)", "an instance member receiver")]
    [InlineData("    Console.WriteLine(Ob.NilNumbers()[0])", "an indexer receiver")]
    [InlineData("    Console.WriteLine(Ob.Nil()!!)", "an explicit '!!'")]
    [InlineData("    Console.WriteLine(Ob.NilNumbers().Count())", "an extension method's receiver (case study 6)")]
    [InlineData("    let f (() -> string) = Ob.Nil().Trim\n    Console.WriteLine(f())", "a method-group capture (the ldftn worst case)")]
    [InlineData("    Console.WriteLine(Ob.Nil().Trim().Length)", "a chained receiver with no syntax (failure mode 3)")]
    [InlineData("    for v in Ob.NilNumbers() {\n        Console.WriteLine(v)\n    }", "a foreach source")]
    [InlineData("    Ob.NilNest().Prop = \"x\"", "a property-write receiver")]
    [InlineData("    let alias List[string?] = Ob.NilStrings()", "a container whose OUTER type is platform-wrapped")]
    [InlineData("    throw Ob.NilException()", "a 'throw' operand")]
    [InlineData("    lock Ob.NilLockTarget() {\n        Console.WriteLine(1)\n    }", "a 'lock' subject")]
    public void Section4_TheCheck_Throws_An_Attributable_NullReferenceException(string body, string site)
    {
        using var world = new World();

        var thrown = Assert.Throws<NullReferenceException>(
            () => world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers));

        // The improvement over an unattributed NRE is the message — §4's whole
        // argument for a call-site check. An empty or default message means
        // the parameterless constructor was emitted, i.e. the site fell back
        // to the plain `!!` lowering and lost its attribution.
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);

        // The site is named too — a bare "was nil" would locate nothing, and
        // §4's whole claim over the CLR's own check is attribution.
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal);
        Assert.False(string.IsNullOrWhiteSpace(thrown.Message), site);
    }

    /// <summary>
    /// The negative control for the fixture above, and §4's "and nowhere else"
    /// clause: a platform value flowing into a <c>T?</c> or <c>T!</c>
    /// destination crosses no boundary, so nothing throws.
    /// <para>
    /// Also covers the two §4 bullets that are easy to get wrong in the unsafe
    /// direction — a <b>type pattern</b> against a nil scrutinee <em>does not
    /// match and does not throw</em> (a pattern test is a question about the
    /// value, not a use of it as non-null), and a guarded <c>?.</c> access.
    /// </para>
    /// </summary>
    [Theory]
    // ADR-0186 §3's last row, end to end. It is small and load-bearing: `nil`
    // into a non-nullable `T` is a binder error and ADR-0155 A9 records that
    // `!!` cannot bridge it, so without this row cs2gs could not translate
    // `return null;` from an oblivious `string`-returning method and §9's
    // whole oblivious-scope mechanism would be unusable. Found as a GS9998
    // emit crash — "Conversion from 'nil' to 'string!' is not yet supported
    // by the emitter" — when the suite was first run with the mode on: the
    // binder admitted the store and emit refused it.
    [InlineData("    Ob.TakesPlatform(nil)", "took nil")]
    [InlineData("    let s string? = Ob.Nil()\n    Console.WriteLine(s == nil)", "True")]
    [InlineData("    let s = Ob.Nil()\n    Console.WriteLine(s == nil)", "True")]
    [InlineData("    takesNilable(Ob.Nil())", "nilable")]
    [InlineData("    Console.WriteLine(Ob.Nil()?.Length)", "")]
    [InlineData("    Console.WriteLine(Ob.Nil() ?? \"fallback\")", "fallback")]
    [InlineData("    let r = switch Ob.Nil() { case v is string: \"matched\" default: \"unmatched\" }\n    Console.WriteLine(r)", "unmatched")]
    [InlineData("    if let v = Ob.Nil() {\n        Console.WriteLine(\"bound\")\n    } else {\n        Console.WriteLine(\"nil\")\n    }", "nil")]
    public void Section4_NoCheck_Is_Inserted_Where_No_NonNull_Destination_Exists(string body, string expected)
    {
        using var world = new World();

        var output = world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers);

        Assert.Equal(expected, output.Trim());
    }

    /// <summary>
    /// ADR-0186 §4's escape hatch: <c>--platform-nil-checks=off</c> suppresses
    /// insertion.
    /// <para>
    /// The ADR insists this be described honestly: it is <b>strictly weaker
    /// than either the old or the new model</b>. Today the same site is a
    /// compile <em>error</em>; with checks off it is neither an error nor a
    /// check, and the nil simply travels until something else notices — which
    /// is exactly what this test observes, by watching the failure move from
    /// gsc's attributable message to an unattributed CLR NRE deeper in.
    /// </para>
    /// </summary>
    [Fact]
    public void Section4_ThePlatformNilChecksSwitch_Suppresses_Insertion()
    {
        const string body = "    let s string = Ob.Nil()\n    Console.WriteLine(s.Length)";
        using var world = new World();

        var withChecks = Assert.Throws<NullReferenceException>(
            () => world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers));
        Assert.Contains("nullability-oblivious", withChecks.Message, StringComparison.Ordinal);

        var withoutChecks = Assert.Throws<NullReferenceException>(
            () => world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers, platformNilChecks: false));
        Assert.DoesNotContain("nullability-oblivious", withoutChecks.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The switch suppresses the <b>check</b>, and nothing else.
    /// <para>
    /// The two were coupled at first, and the coupling was invisible to the
    /// fixture above because a declared-slot store is the one shape that does
    /// not need the unwrap. The same helper that inserts §4's check is also
    /// §5's mechanism — replacing a platform receiver with one typed at the
    /// bare underlying is what makes member lookup run against <c>T</c> — so
    /// returning the still-wrapped expression turned <em>working</em> indexer
    /// and <c>for … in</c> code into GS0116 "not indexable" compile errors
    /// under a switch whose entire purpose is to drop a runtime check for
    /// measurement. A measurement switch that changes what compiles measures
    /// nothing.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    [Theory]
    [InlineData("    Console.WriteLine(Ob.Numbers()[0])")]
    [InlineData("    for v in Ob.Numbers() {\n        Console.WriteLine(v)\n    }")]
    [InlineData("    Console.WriteLine(Ob.Value().Length)")]
    [InlineData("    Ob.Nest2().Prop = \"x\"")]
    public void Section4_ThePlatformNilChecksSwitch_Suppresses_Only_The_Check(string body)
    {
        using var world = new World();

        // Compiles either way: the switch must not move the binder.
        Assert.True(
            world.Compile(body, NullabilityMode.PlatformTypes, platformNilChecks: true).Success,
            "checks on");
        Assert.True(
            world.Compile(body, NullabilityMode.PlatformTypes, platformNilChecks: false).Success,
            "checks off");
    }


    /// <summary>
    /// ADR-0186 §3's overload tie-break: a <c>T!</c> argument is applicable to
    /// both a <c>T</c> and a <c>T?</c> parameter, and <c>T</c> wins.
    /// <para>
    /// Worth its own fixture because nothing else can catch it. Every
    /// conversion kind the ranker compares is derived from CLR types, and
    /// <c>string</c>, <c>string?</c> and <c>string!</c> are one CLR type, so
    /// the two candidates tie and the rule has to be stated explicitly in
    /// <c>ComparePlatformArgumentTargets</c>. Reverting that method leaves
    /// every other test in this PR green.
    /// </para>
    /// <para>
    /// ADR open question 10 records this as the one place the design
    /// reproduces failure mode 5's <em>shape</em> — the same line selecting a
    /// different method by typing — and accepts it deliberately, because the
    /// <c>T</c> overload is the one a non-nilable argument would have picked
    /// and CLR metadata cannot express such a pair. Accepted deliberately is
    /// exactly the kind of decision that needs a witness.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_APlatformArgument_Prefers_The_NonNull_Overload()
    {
        const string overloads = """
            func G(s string) string {
                return "non-null"
            }

            func G(s string?) string {
                return "nilable"
            }
            """;

        using var world = new World();

        // The control: a G#-declared `string?` argument picks the `T?`
        // overload, so the pair really is discriminating.
        Assert.Equal(
            "nilable",
            world.Run(
                "    let n string? = \"x\"\n    Console.WriteLine(G(n))",
                NullabilityMode.PlatformTypes,
                extraDeclarations: overloads).Trim());

        // The rule: a `string!` argument picks the non-null overload.
        Assert.Equal(
            "non-null",
            world.Run(
                "    Console.WriteLine(G(Ob.Value()))",
                NullabilityMode.PlatformTypes,
                extraDeclarations: overloads).Trim());
    }

    /// <summary>
    /// ADR-0186 §6: every null-handling construct accepts a <c>T!</c>, and the
    /// diagnostic that used to reject it does not fire.
    /// <para>
    /// Each row names the diagnostic it pins. These are all "gains <c>T!</c>
    /// on the admits-nil side of its test" rows in §7's table, and each one
    /// was measurably firing on step 1's baseline — the fixture is a
    /// difference, not a restatement.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="diagnostic">The diagnostic that must not fire.</param>
    [Theory]
    [InlineData("    if let v = Ob.Value() {\n        Console.WriteLine(v)\n    }", "GS0296")]
    [InlineData("    guard let v = Ob.Value() else { return }\n    Console.WriteLine(v)", "GS0296")]
    [InlineData("    var s = Ob.Value()\n    s ??= \"x\"\n    Console.WriteLine(s)", "GS0298")]
    [InlineData("    Console.WriteLine(Ob.Value() ?? \"x\")", "GS0298")]
    [InlineData("    Console.WriteLine(Ob.Value()?.Length)", "GS0300")]
    [InlineData("    Console.WriteLine(Ob.Table()?[\"k\"])", "GS0300")]
    [InlineData("    Console.WriteLine(Ob.Value() == nil)", "GS0129")]
    [InlineData("    Console.WriteLine(Ob.Table() == nil)", "GS0523")]
    [InlineData("    Console.WriteLine(Ob.Value()!!)", "GS0536")]
    public void Section6_EveryNullHandlingConstruct_Accepts_APlatformOperand(string body, string diagnostic)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);

        Assert.True(compiled.Success, Describe(compiled));
        Assert.DoesNotContain(compiled.Diagnostics, d => d.Id == diagnostic);
    }

    /// <summary>
    /// The negative half of §6: the diagnostics above are <b>narrowed, not
    /// deleted</b>. A genuinely non-null <c>T</c> operand still reports each
    /// one, so the fixture above is a statement about <c>T!</c> and not a
    /// blanket weakening of G#'s own null model — which ADR-0186 lists under
    /// "Explicitly out of scope".
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="diagnostic">The diagnostic that must still fire.</param>
    [Theory]
    [InlineData("    let plain string = \"v\"\n    if let v = plain {\n        Console.WriteLine(v)\n    }", "GS0296")]
    [InlineData("    var plain string = \"v\"\n    plain ??= \"x\"\n    Console.WriteLine(plain)", "GS0298")]
    [InlineData("    let plain = Dictionary[string, int32]()\n    Console.WriteLine(plain?[\"k\"])", "GS0300")]
    [InlineData("    let plain string = \"v\"\n    Console.WriteLine(plain!!)", "GS0536")]
    public void Section6_TheSameDiagnostics_Still_Fire_For_APlainNonNullOperand(string body, string diagnostic)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);

        Assert.Contains(compiled.Diagnostics, d => d.Id == diagnostic);
    }

    /// <summary>
    /// ADR-0069 narrowing applies to a <c>T!</c>, and this is what makes the
    /// platform model ergonomic rather than merely permissive: inside
    /// <c>if x != nil { … }</c> the value has type <c>T</c>, so the coercion
    /// that follows is not a <c>T! → T</c> coercion at all and §4 inserts
    /// nothing.
    /// <para>
    /// <b>Asserted by counting the synthesized checks in the bound tree</b>,
    /// because nothing weaker discriminates. An earlier version of this test
    /// used a nil-valued source, which made the guarded branch dead and let
    /// it pass whether or not narrowing happened; and even in a reachable
    /// branch a plain "it compiles" assertion proves nothing, since
    /// <c>T! → T</c> is an implicit conversion either way — it just carries
    /// a check. The check count is the only observable that moves.
    /// </para>
    /// <para>
    /// This was a real gap, not a hypothetical one:
    /// <c>SmartCastStability.TryClassifyNilGuardLeaf</c> tested
    /// <c>is not NullableTypeSymbol</c> and so rejected every platform target
    /// outright, which made §6's narrowing claim false for <c>T!</c>.
    /// </para>
    /// </summary>
    [Fact]
    public void Section6_Narrowing_Applies_And_Removes_The_Coercion()
    {
        const string guarded = """
                let value = Ob.Value()
                if value != nil {
                    let narrowed string = value
                    Console.WriteLine(narrowed)
                }
            """;

        const string unguarded = """
                let value = Ob.Value()
                let narrowed string = value
                Console.WriteLine(narrowed)
            """;

        using var world = new World();

        // The control: with no guard, the store is a `T! -> T` coercion and
        // §4 inserts exactly one check.
        Assert.Equal(1, world.CountPlatformChecks(unguarded));

        // The claim: after the guard the read is already `T`, so there is no
        // coercion left to check.
        Assert.Equal(0, world.CountPlatformChecks(guarded));

        // …and it still runs, on the branch that is actually reachable.
        Assert.Equal("V", world.Run(guarded, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// ADR-0186 §3's unification rule in a ternary, both arm orders.
    /// <para>
    /// The same <c>T!?</c> defect as <c>?.</c> and <c>??</c> reached here
    /// too, and worse: the common-type computation picks whichever arm it
    /// sees first, so <c>platform ? : nilable</c> and
    /// <c>nilable ? : platform</c> produced <em>different</em> result types.
    /// A type that depends on the order the author happened to write the arms
    /// in is not a type rule at all.
    /// </para>
    /// <para>
    /// Fixed by the same normalisation as the others (<c>T!?</c> collapses to
    /// <c>T?</c> at <c>NullableTypeSymbol.Get</c>), which is the argument for
    /// having centralised it: this site was never touched directly.
    /// </para>
    /// </summary>
    /// <param name="globals">A probe declaring <c>probe</c>.</param>
    /// <param name="expected">The expected unified type.</param>
    [Theory]
    [InlineData("let n string? = \"n\"\nlet probe = if true { Ob.Value() } else { n }", "string?")]
    [InlineData("let n string? = \"n\"\nlet probe = if true { n } else { Ob.Value() }", "string?")]

    // lub(`T!`, `T`) is `T!` — deliberately NOT symmetric absorption, since a
    // `T` arm says nothing whatever about the platform arm.
    [InlineData("let probe = if true { Ob.Value() } else { \"x\" }", "string!")]
    public void Section3_TernaryUnification_Is_ArmOrderIndependent(string globals, string expected)
    {
        using var world = new World();

        var unified = world.GlobalProbeType(globals, NullabilityMode.PlatformTypes);

        Assert.Equal(expected, unified.Name);
    }

    /// <summary>
    /// ADR-0186 §8, the half step 3 cannot do without: a platform type
    /// <b>reaches the emitter from ordinary source</b>, and it must be
    /// encoded rather than refused.
    /// <para>
    /// Step 1 made <c>NullableFlagsBuilder.Append</c> throw
    /// <c>NotSupportedException</c> for a <c>T!</c>, on the reasoning that
    /// the path was unreachable with the flag off and that the alternative
    /// then available — the fall-through writing byte <c>1</c> — would
    /// launder an unknown into a guarantee in metadata. Both halves were
    /// right; only the first stopped being true. Every row below is a
    /// <em>synthesized member signature</em> whose type came from type
    /// inference over an oblivious call, with no <c>@Oblivious</c> anywhere
    /// and nothing from §9:
    /// </para>
    /// <list type="bullet">
    /// <item><description>a global <c>let</c> with no type clause — a static
    /// field of type <c>string!</c>;</description></item>
    /// <item><description>a local captured by a lambda — a display-class
    /// field of type <c>string!</c>;</description></item>
    /// <item><description>a local captured across a <c>defer</c>, which is
    /// the shape <c>DeferStatementTests</c> hit.</description></item>
    /// </list>
    /// <para>
    /// This is the fixture that says the refusal was a step-3 blocker and not
    /// a test artifact. Each row turns red on the parent commit with the
    /// emitter's <c>NotSupportedException</c>, and the byte it now writes is
    /// pinned — at <c>0</c>, never <c>1</c> — by
    /// <c>Adr0186PlatformTypeSymbolTests.Emit_Encodes_A_Platform_Type_As_The_Oblivious_Byte</c>.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="extra">Extra top-level declarations.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData(
        "    let s = Ob.Value()\n    let f = func() string { return s }\n    Console.WriteLine(f())",
        "",
        "V")]
    [InlineData(
        "    let s = Ob.Value()\n    defer Console.WriteLine(s)",
        "",
        "V")]
    public void Section8_APlatformTypedSynthesizedSignature_Emits_Rather_Than_Refusing(
        string body,
        string extra,
        string expected)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes, extra);
        Assert.True(compiled.Success, Describe(compiled));

        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes, extra).Trim());
    }

    /// <summary>
    /// The third synthesized-signature shape: a <b>global</b> <c>let</c> with
    /// no type clause, which becomes a static field typed <c>string!</c>.
    /// <para>
    /// Asserted on <em>emit success</em> only, not on program output, and the
    /// reason is a property of the fixture rather than of this change: this
    /// world's probe source declares <c>func Main()</c> as the entry point,
    /// and a top-level global's initializer does not run ahead of it here —
    /// measured with a platform-free <c>let probe = "V"</c>, which prints
    /// nothing either. Asserting output would be asserting that fixture
    /// quirk. What this row is for is the emitter, and the emitter is
    /// exactly what threw: on the parent commit this reports
    /// <c>NotSupportedException: Cannot emit nullable metadata for the
    /// platform type 'string!'</c>.
    /// </para>
    /// </summary>
    [Fact]
    public void Section8_AGlobalInferredLet_Emits_ItsPlatformTypedField()
    {
        using var world = new World();

        var compiled = world.Compile(
            "    Console.WriteLine(probe)",
            NullabilityMode.PlatformTypes,
            "let probe = Ob.Value()");

        Assert.True(compiled.Success, Describe(compiled));
    }

    /// <summary>
    /// Issue #4323 — ADR-0186 §5a for the indexer <b>write</b> path.
    /// <para>
    /// Failure mode 1 of the ADR's catalogue, one access kind over: reading
    /// <c>l[0]</c> through a platform receiver bound correctly because
    /// <c>BindIndexAgainstTarget</c> unwraps, while writing <c>l[0] = "q"</c>
    /// reported GS0116 <em>"type 'List[string]!' is not indexable"</em>,
    /// because the assignment path had no equivalent. A receiver's
    /// platform-ness deciding whether a member exists is precisely what §5a
    /// forbids, and "the read path and the write path drifted" is how the
    /// predicate system this ADR replaces started.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData("    let l = Ob.WrapList(\"a\")\n    l[0] = \"q\"\n    Console.WriteLine(l[0])", "q")]
    [InlineData("    let t = Ob.Table()\n    t[\"k\"] = 9\n    Console.WriteLine(t[\"k\"])", "9")]
    [InlineData("    let a = Ob.ArrWithNil()\n    a[0] = \"q\"\n    Console.WriteLine(a[0])", "q")]
    public void Section5_TheIndexerWritePath_Unwraps_Like_TheReadPath(string body, string expected)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);
        Assert.True(compiled.Success, Describe(compiled));
        Assert.DoesNotContain(compiled.Diagnostics, d => d.Id == "GS0116");

        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// Issue #4324 — ADR-0186 §6 for the concatenation operator.
    /// <para>
    /// <c>string! + "x"</c> reported GS0129 <em>"operator '+' is not defined
    /// for types 'string!' and 'string'"</em> in both operand orders, because
    /// <c>BoundBinaryOperator.IsStringOrNullableString</c> tested only
    /// <c>string</c> and <c>string?</c> while the <c>supportedOperators</c>
    /// table matches operand types exactly and cannot see through a wrapper.
    /// §6's claim is that <c>T!</c> participates in every existing construct;
    /// an oblivious string being <em>less</em> capable than either a
    /// <c>string</c> or a <c>string?</c> is that claim failing.
    /// </para>
    /// <para>
    /// The <c>string? + "x"</c> control is what makes this a difference
    /// rather than a restatement: it has compiled since issue #1927, and the
    /// platform row is being brought into line with it, not given a new rule.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData("    Console.WriteLine(Ob.Value() + \"x\")", "Vx")]
    [InlineData("    Console.WriteLine(\"x\" + Ob.Value())", "xV")]
    [InlineData("    Console.WriteLine(Ob.Value() + Ob.Suffix())", "Vx")]

    // A nil platform operand concatenates as the empty string, exactly as a
    // nil `string?` does. No §4 check fires here, and that is deliberate:
    // the operand never reaches a non-null destination.
    [InlineData("    Console.WriteLine(\"[\" + Ob.Nil() + \"]\")", "[]")]

    // The control: the same shape with a source-declared `string?`, which has
    // compiled since #1927.
    [InlineData("    let n string? = nil\n    Console.WriteLine(\"[\" + n + \"]\")", "[]")]
    public void Section6_StringConcatenation_Accepts_APlatformOperand(string body, string expected)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);
        Assert.True(compiled.Success, Describe(compiled));

        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// Issue #4324, the half the first fix missed: a <b>char</b> operand.
    /// <para>
    /// <c>string + char</c> is not in the operator table at all — the binder
    /// adapts the char to a string first (issue #3463), and that adaptation
    /// recognised its string side only as <c>string</c> or <c>string?</c>. So
    /// <c>string! + "x"</c> bound while <c>string! + 'c'</c> and
    /// <c>s += 'c'</c> on a <c>string!</c> local reported GS0129 — reached in
    /// the nightly self-migration corpus by <c>Gsharp.NET.Sdk</c>, which
    /// targets netstandard2.0 and so sees every BCL string as <c>string!</c>.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData("    Console.WriteLine(Ob.Value() + 'c')", "Vc")]
    [InlineData("    Console.WriteLine('c' + Ob.Value())", "cV")]
    [InlineData("    var s = Ob.Value()\n    s += 'c'\n    Console.WriteLine(s)", "Vc")]
    [InlineData("    var s = Ob.Value()\n    s += \"y\"\n    Console.WriteLine(s)", "Vy")]
    [InlineData("    Console.WriteLine(\"[\" + Ob.Nil() + ']')", "[]")]
    public void Section6_StringConcatenation_WithAChar_Accepts_APlatformOperand(string body, string expected)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);
        Assert.True(compiled.Success, Describe(compiled));

        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// Issue #4361: an <b>open type-parameter slot</b> of an unannotated
    /// declaration takes its nullability from the type argument (ADR-0186
    /// §2), so a generic call's result converts exactly as the same call to an
    /// annotated declaration would — only the concrete container position is
    /// platform-typed.
    /// <para>
    /// Each row is a shape that took <c>main</c>'s nightly self-migration
    /// corpus red: the reader stamped the declaration's ABSENT nullability
    /// byte onto the substituted argument, inventing a nested <c>T!</c> that
    /// §3 rule 3 then correctly refused to convert (<c>[]string!</c> to
    /// <c>[]?string</c>, <c>IEnumerable[string!]!</c> to
    /// <c>IEnumerable[string]?</c>, <c>Arbitrary[Type!]</c> to
    /// <c>Arbitrary[Type]</c>).
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]

    // `Array.Empty[T]()` into a nullable array, and into a non-null one
    // (the platform CONTAINER is checked; its elements are plain `string`).
    [InlineData("    var a []?string = Ob.EmptyArr[string]()\n    Console.WriteLine(a!!.Length)", "0")]
    [InlineData("    var a []string = Ob.EmptyArr[string]()\n    Console.WriteLine(a.Length)", "0")]

    // `Enumerable.Empty[T]()` into a nullable interface, and as a `??` fallback.
    // The `??` rows are BINDING witnesses for #4361's GS0129 ("'??' is not
    // defined for 'IEnumerable[string]?' and 'IEnumerable[string!]!'"), not
    // a claim about the fallback's nil safety: the result of `x ?? y` is
    // the non-null underlying whatever `y`'s platform-ness (ADR-0186 §6,
    // pinned by cs2gs's `Issue2579` contract), so the `!!` in the second row —
    // kept because it is the migrated corpus's exact spelling — is redundant.
    [InlineData("    var e IEnumerable[string]? = Ob.EmptySeq[string]()\n    Console.WriteLine(e!!.Count())", "0")]
    [InlineData("    let x IEnumerable[string]? = nil\n    let p = x ?? Ob.EmptySeq[string]()\n    Console.WriteLine(p.Count())", "0")]
    [InlineData("    let x IEnumerable[string]? = nil\n    let p = (x ?? Ob.EmptySeq[string]())!!\n    Console.WriteLine(p.Count())", "0")]

    // `T` INFERRED from a fully-typed argument (`Array.FindAll(xs, …)`).
    [InlineData("    let xs = []string{\"a\"}\n    let r []string = Ob.Same(xs)\n    Console.WriteLine(r[0])", "a")]

    // A generic type argument (FsCheck's `Arb.From(gen)!!`).
    [InlineData("    let h Holder[string] = Ob.Hold(\"x\")!!\n    Console.WriteLine(h.Value)", "x")]
    public void Section2_AnOpenSlot_OfAnUnannotatedGeneric_Converts_Like_ItsArgument(string body, string expected)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);
        Assert.True(compiled.Success, Describe(compiled));

        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// Issue #4361, at the reader: an open slot of an unannotated generic reads
    /// the argument's nullability, the concrete container stays oblivious, and
    /// a CONCRETE inner position is untouched. Observed through the display,
    /// which is also issue #4361's diagnostic fix: an imported platform array
    /// is spelled <c>[]!T</c> (ADR-0132's positional rule) and a nested
    /// platform argument shows its <c>!</c>.
    /// <para>
    /// Uses the csc-emitted library rather than an in-assembly
    /// <c>#nullable disable</c> fixture on purpose: the latter stops being
    /// oblivious when <c>test/Core.Tests</c> is itself self-migrated to G#,
    /// and the migrated suite's test parity would then fail it.
    /// </para>
    /// </summary>
    /// <param name="globals">The probe.</param>
    /// <param name="expected">The expected display of the probe's type.</param>
    [Theory]
    [InlineData("let probe = Ob.EmptyArr[string]()", "[]!string")]
    [InlineData("let probe = Ob.EmptySeq[string]()", "System.Collections.Generic.IEnumerable[string]!")]
    [InlineData("let probe = Ob.Hold(\"x\")", "Adr0186.Step2.Library.Holder[string]!")]
    [InlineData("let probe = Ob.Strings()", "System.Collections.Generic.List[string!]!")]
    public void Section2_AnOpenSlot_OfAnUnannotatedGeneric_Reads_ItsArgument(string globals, string expected)
    {
        using var world = new World();

        Assert.IsType<PlatformTypeSymbol>(world.GlobalProbeType(globals, NullabilityMode.PlatformTypes));
        Assert.Equal(expected, world.LastProbeDisplay);
    }

    /// <summary>
    /// ADR-0186 §3 rule 2 at an <b>indexer parameter</b>: a
    /// <c>C[T!]</c> argument stays applicable to a <c>C[T?]</c> parameter.
    /// <para>
    /// Rule 2 is the single conversion a constructed type permits, and
    /// symbolic indexer applicability has to honour it.
    /// <c>TryClassifyConstructedGenericConversion</c>'s invariant arm uses
    /// <c>SameTypeSymbol</c> as its <em>complete</em> verdict and returns
    /// before the general classifier runs, so once that helper correctly
    /// stopped calling <c>string!</c> and <c>string?</c> the same type, a
    /// non-identical pair would have been read as final incompatibility —
    /// Copilot review finding on the flip PR. The arm now also asks
    /// <c>Conversion.IsPlatformArgumentWidening</c>, which is the same
    /// implementation the classifier uses rather than a second copy of the
    /// rule.
    /// </para>
    /// <para>
    /// <b>Asserted at the relation, not end to end, and that is a
    /// limitation worth stating.</b> The symbolic-indexer path this guards is
    /// only entered when some argument has no <c>ClrType</c> — a
    /// same-compilation user type — and a <c>C[T!]</c> argument always has
    /// one, so an end-to-end probe goes through CLR resolution instead and
    /// passes with or without the fix (measured: it does not discriminate).
    /// The production change is therefore <em>defensive</em>: correct
    /// wherever the relation is asked, but with no constructed repro. What
    /// this test pins is the rule itself, which does discriminate — removing
    /// the <c>Widening</c> arm from <c>RelatePlatformArguments</c> reddens
    /// it.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_RuleTwoWidening_Is_The_OnlyPermitted_ArgumentRelation()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);
        var nilable = NullableTypeSymbol.Get(TypeSymbol.String);

        // Rule 2: `T! -> T?` is the one permitted widening.
        Assert.True(GsConversion.IsPlatformArgumentWidening(platform, nilable));

        // Rule 3's three illegal directions, and the identity case, are all
        // NOT widenings — so the applicability arm that consults this cannot
        // reopen the aliasing hole it was added beside.
        Assert.False(GsConversion.IsPlatformArgumentWidening(platform, TypeSymbol.String));
        Assert.False(GsConversion.IsPlatformArgumentWidening(TypeSymbol.String, platform));
        Assert.False(GsConversion.IsPlatformArgumentWidening(nilable, platform));
        Assert.False(GsConversion.IsPlatformArgumentWidening(platform, platform));

        // A platform-free pair is not this relation's business at all.
        Assert.False(GsConversion.IsPlatformArgumentWidening(TypeSymbol.String, nilable));

        // …and its companion, which is what keeps rule 3 closed at an
        // applicability check whose same-type helper deliberately looks
        // THROUGH the platform wrapper. `SameTypeSymbol` has to unwrap —
        // member hiding needs `T!` and `T` to be one signature, and making
        // them distinct there collapsed `Issue2525`'s interface diamond into
        // GS0266 "ambiguous between multiple overloads". So the two
        // questions are asked separately rather than folded into one helper.
        Assert.True(GsConversion.IsPlatformArgumentIllegal(platform, TypeSymbol.String));
        Assert.True(GsConversion.IsPlatformArgumentIllegal(TypeSymbol.String, platform));
        Assert.True(GsConversion.IsPlatformArgumentIllegal(nilable, platform));
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platform, nilable));
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platform, platform));
        Assert.False(GsConversion.IsPlatformArgumentIllegal(TypeSymbol.String, nilable));

        // An UNRELATED pair is neither: rule 3 speaks only about two
        // positions that are the same underlying type differing in reference
        // nullability, and `Illegal` means "no conversion exists" rather than
        // "this arm cannot decide". Both directions, because the guard
        // existed on one arm and not the other — a Copilot review finding on
        // this PR, in each direction in turn.
        var platformObject = PlatformTypeSymbol.Get(TypeSymbol.Object);
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platformObject, TypeSymbol.String));
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platformObject, nilable));
        Assert.False(GsConversion.IsPlatformArgumentIllegal(TypeSymbol.String, platformObject));
        Assert.False(GsConversion.IsPlatformArgumentWidening(platformObject, nilable));

        // …and the reason the symbolic-indexer check asks
        // `TryRelatePlatformContainer` rather than either of these two.
        //
        // They answer about a single ARGUMENT position whose container has
        // ALREADY been matched. Asked about the containers themselves they
        // have no shape guard: `[]string! -> object` is an ordinary upcast
        // whose two sides have no corresponding argument positions at all, so
        // `RelateNestedPlatformArguments` cannot pair them and reports
        // `Illegal` — which, used as an applicability verdict, would stop an
        // indexer taking `object` from accepting an oblivious string array.
        // Measured here rather than argued, because the claim is the whole
        // justification for the shape of that call.
        var platformSlice = SliceTypeSymbol.Get(platform);
        Assert.True(GsConversion.IsPlatformArgumentIllegal(platformSlice, TypeSymbol.Object));
        Assert.False(GsConversion.TryRelatePlatformContainer(platformSlice, TypeSymbol.Object, out _));
    }

    /// <summary>
    /// The symbolic-indexer counterpart of
    /// <c>TheContainerRule_Does_Not_Decide_OuterNullability</c>: a
    /// <b>nilable</b> container must not be accepted — still less
    /// <em>preferred</em> — where a non-null one is required.
    /// <para>
    /// <c>TryClassifyPlatformTypeArgumentMismatch</c> declines
    /// <c>C[T!]? -&gt; C[T?]</c> on purpose, so that the ordinary
    /// outer-nullability rule can reject the nilable container. But
    /// "declined" and "this pair is unrelated" reach
    /// <c>ClassifySymbolicIndexerConversion</c> as the same <c>false</c>, and
    /// its same-type fast path strips a top-level reference <c>?</c> from
    /// either side — so the pair came back <em>identical</em>, the best match
    /// a candidate can be. Copilot review finding on the flip PR.
    /// </para>
    /// <para>
    /// <b>The competitor is what makes it observable.</b> On its own the
    /// over-accepted candidate is still caught, one step later, by the
    /// argument conversion — GS0156 <em>"Cannot convert type
    /// 'List[string]?' to 'List[string?]'"</em>. With a legal
    /// <c>this[object?]</c> present, the mis-ranked candidate wins the ranking
    /// outright and takes the whole access down with it, where rejecting it
    /// leaves <c>object?</c> to bind.
    /// </para>
    /// <para>
    /// <b>Measured as NOT platform-specific</b>, which is why the fix is the
    /// fast path rather than the platform arm: the third case runs the same
    /// program under <c>--nullability=enabled</c>, where no platform type
    /// exists anywhere, and it mis-selected identically before the fix. The
    /// fast path has always erased outer reference nullability; ADR-0186 is
    /// only what made someone look.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_ANilableContainer_Is_Not_Identical_To_ANonNullOne()
    {
        using var world = new World();

        // `AsNilable` is how the probe gets a genuine nilable OVER a platform
        // container — an inferred `let` cannot, because `T!` already admits
        // nil and a `nil` branch merges into it without adding a `?`.
        const string decls = """
            func AsNilable[T](x T) T? {
                return x
            }
            """;

        const string alone = """
                let k = AsNilable(Ob.Strings())
                Console.WriteLine(NilableKeys()[k])
            """;

        var rejected = world.Compile(alone, NullabilityMode.PlatformTypes, decls);
        Assert.False(rejected.Success, Describe(rejected));

        // The witness: with a legal competitor, the nilable container must
        // lose rather than win-and-fail. Mutating out the outer-nullability
        // guard reddens this with GS0156.
        const string competing = """
                let k = AsNilable(Ob.Strings())
                Console.WriteLine(NilableOrObjectKeys()[k])
            """;

        Assert.Equal(
            "object",
            world.Run(competing, NullabilityMode.PlatformTypes, decls).Trim());

        // …and the same program with no platform type anywhere, which is what
        // establishes the defect as pre-existing rather than introduced by
        // the flip.
        Assert.Equal(
            "object",
            world.Run(competing, NullabilityMode.Enabled, decls).Trim());
    }

    /// <summary>
    /// ADR-0186 §3 at a symbolic indexer parameter, <b>end to end</b> — and
    /// the fast path it has to be asked before.
    /// <para>
    /// <c>ClassifySymbolicIndexerConversion</c> opened with
    /// <c>SameTypeSymbol</c>, which looks through a platform wrapper by design
    /// (member hiding needs <c>T!</c> and <c>T</c> to be one CLR signature —
    /// making them distinct there collapsed <c>Issue2525</c>'s interface
    /// diamond into GS0266). So it answered <em>identity</em> for
    /// <c>List[string!]</c> against <c>List[string]</c> and returned before
    /// the rule-3 guard below it ever ran: the aliasing conversion the guard
    /// exists to reject stayed applicable, and rule 2's
    /// <c>List[string!] -&gt; List[string?]</c> — a permitted
    /// <em>non-identity</em> widening — was mis-ranked as identity, which the
    /// candidate ranker prefers. Copilot review finding on the flip PR.
    /// </para>
    /// <para>
    /// The question is now asked through
    /// <c>Conversion.TryRelatePlatformContainer</c>, the same guarded entry
    /// the general classifier on the last line of that method already uses —
    /// so this is a hoist above the fast path, not a new rule — and
    /// deliberately not through the per-<em>argument</em> predicates one
    /// method down, which assume a container that has already been matched
    /// and would answer <c>Illegal</c> for an ordinary upcast such as
    /// <c>[]string! -&gt; object</c>.
    /// </para>
    /// <para>
    /// <b>Why this fixture and not a simpler one.</b> The symbolic path is
    /// entered only when an argument has no <c>ClrType</c> or the receiver
    /// type has a set-only indexer, and a <c>List[string!]</c> argument always
    /// has a <c>ClrType</c> — an earlier attempt at this test went through
    /// reflection against the erased CLR shape instead and passed with the fix
    /// mutated out. Hence <c>ExactKeys</c>/<c>NilableKeys</c>' set-only
    /// <c>int</c> member, which also makes an empty applicable set final
    /// rather than a fallback to that erased retry. Mutation witness:
    /// removing the hoist compiles the second probe, which is the aliasing
    /// hole.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_SymbolicIndexerApplicability_Asks_TheRule_Before_TheSameTypeFastPath()
    {
        using var world = new World();

        // Rule 2: `List[string!]! -> List[string?]` is the one container
        // conversion the ADR permits, and it must stay applicable — a guard
        // that rejected everything platform-shaped would redden here.
        const string permitted = """
                let keys = Ob.Strings()
                Console.WriteLine(NilableKeys()[keys])
            """;
        Assert.Equal("nilable", world.Run(permitted, NullabilityMode.PlatformTypes).Trim());

        // Rule 3: `List[string!]! -> List[string]` hands a container that
        // demonstrably holds a nil (`Strings()`' second element) to a
        // parameter annotated never to. No check can be inserted — the nil is
        // inside the container, not the reference being converted — so the
        // only sound answer is that the indexer is not applicable.
        const string illegal = """
                let keys = Ob.Strings()
                Console.WriteLine(ExactKeys()[keys])
            """;
        var rejected = world.Compile(illegal, NullabilityMode.PlatformTypes);
        Assert.False(rejected.Success, "rule 3 must reject C[T!] -> C[T]: " + Describe(rejected));

        // …and the discriminator, because the two probes above pass either
        // way. Applicability and the later argument conversion are separate
        // steps, and the conversion step applies rule 3 too — so an
        // over-accepted candidate is still caught, just one step further on
        // and with the whole access lost. What only SELECTION can show is a
        // legal competitor: with the rule asked first, the `List[string]`
        // indexer is out of the running and `this[object]` binds; with the
        // same-type fast path first, `List[string]` is reported IDENTICAL —
        // the best possible match — wins the ranking, and the access then
        // fails at conversion with GS0155 *"Cannot convert type
        // 'List[string]!' to 'List[string]'"*, naming one type twice.
        const string competing = """
                let keys = Ob.Strings()
                Console.WriteLine(OverloadedKeys()[keys])
            """;
        Assert.Equal("object", world.Run(competing, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// ADR-0186 §4: the receiver check elided inside an expression-tree
    /// lambda is <b>redundant, not missing</b> — the tree still throws.
    /// <para>
    /// Review objected that <c>Expression.Call</c> on a non-virtual method
    /// may emit <c>call</c>, which does not reject a null <c>this</c>, so a
    /// member that never touches its receiver could complete on a nil and
    /// lose the failure entirely rather than merely its message. That is
    /// exactly the kind of claim ADR-0186 says is worth only as much as the
    /// enumeration behind it — its own §4 receiver exemption was falsified
    /// that way — so it is measured here rather than argued.
    /// </para>
    /// <para>
    /// Measured directly against <c>System.Linq.Expressions</c> (sealed
    /// class, field and property receivers, auto-property and a getter that
    /// provably never reads <c>this</c>): <b>all four throw
    /// <c>NullReferenceException</c></b>. The expression compiler emits the
    /// dereferencing form for instance member access regardless of
    /// virtuality, exactly as <c>csc</c> does. This test keeps that a live
    /// assertion through G#'s own pipeline: what is lost by the elision is
    /// G#'s message (#4352), never the failure.
    /// </para>
    /// </summary>
    [Fact]
    public void Section4_AnElidedReceiverCheck_Still_Throws_When_TheTreeRuns()
    {
        using var world = new World();

        var output = world.Run(
            """
                let n = Ob.NilNest()
                let e Expression[Func[string?]] = () -> n.Prop
                let c = e.Compile()
                try {
                    Console.WriteLine(c())
                } catch (NullReferenceException) {
                    Console.WriteLine("threw")
                }
            """,
            NullabilityMode.PlatformTypes);

        Assert.Equal("threw", output.Trim());
    }

    /// <summary>
    /// ADR-0186 §6: reference <b>equality</b> with a platform operand takes
    /// no §4 check, because comparing two references is not a use of either
    /// as non-null.
    /// <para>
    /// §4's sites are a store, an argument, a return, a
    /// <c>throw</c>/<c>lock</c>/<c>for … in</c> subject and a receiver.
    /// <c>==</c> is none of them: it never dereferences. §6 already makes
    /// <c>x == nil</c> free on a <c>T!</c>, and comparing against a non-nil
    /// <c>string</c> is the same operation with a different right-hand side.
    /// </para>
    /// <para>
    /// Without the operator arm, the <c>supportedOperators</c> lookup missed
    /// (it is an exact type match and cannot see through a wrapper),
    /// resolution fell through to the CLR <c>op_Equality</c>, and the
    /// platform operand became an <em>argument</em> to a non-null
    /// parameter — so a check was inserted on a comparison. That spurious
    /// check is what made
    /// <c>Issue2661ExpressionTreeNullablePipelineTests</c>' <c>.Where(b -&gt;
    /// b.Conversion.AccountId == id)</c> report GS0473, since a non-receiver
    /// coercion inside an expression-tree lambda is (correctly) rejected.
    /// </para>
    /// <para>
    /// Asserted by <b>counting the synthesized checks</b>, which is the only
    /// observable that moves — the comparison compiles either way.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    [Theory]
    [InlineData("    let x = Ob.Value() == \"v\"\n    Console.WriteLine(x)")]
    [InlineData("    let x = \"v\" == Ob.Value()\n    Console.WriteLine(x)")]
    [InlineData("    let x = Ob.Value() != Ob.Suffix()\n    Console.WriteLine(x)")]
    public void Section6_ReferenceEquality_With_APlatformOperand_Inserts_NoCheck(string body)
    {
        using var world = new World();

        Assert.Equal(0, world.CountPlatformChecks(body));
        Assert.True(world.Compile(body, NullabilityMode.PlatformTypes).Success);
    }

    /// <summary>
    /// Issue #4325 — the three remaining §4 positions: delegate invocation,
    /// compound member assignment, and deconstruction.
    /// <para>
    /// None of these was a silent escape — each already failed at runtime for
    /// a nil platform value. What was missing is the <em>attribution</em>,
    /// which is the entire justification §4 gives for preferring a call-site
    /// check over whatever the CLR happens to do: an
    /// <c>NullReferenceException</c> naming the expression, the oblivious
    /// origin, and the file:line beats a bare one from inside a lowered
    /// construct.
    /// </para>
    /// <para>
    /// Asserted on the <b>message</b>, not on the exception type, because the
    /// type does not move: §4 keeps <c>NullReferenceException</c> deliberately
    /// so existing <c>catch</c> clauses behave as they do. A test that
    /// asserted only "it throws" would be green on the parent commit.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="site">What the row covers.</param>
    [Theory]
    [InlineData("    let f = Ob.NilThunk()\n    Console.WriteLine(f())", "delegate invocation")]

    // The parenthesised callee is a DIFFERENT binder path (issue #2185's
    // `(expr)(args)` shape, which carries a non-null `syntax.Callee` and
    // routes through `BindIndirectCallExpression` instead of the bare-name
    // delegate-variable arm). Both are covered because covering only one is
    // how failure mode 3 shipped: `s.ToUpper()` reported and
    // `(s.ToUpper()).Trim()` did not, for the life of the "fix".
    [InlineData("    let f = Ob.NilThunk()\n    Console.WriteLine((f)())", "delegate invocation, parenthesised callee")]
    [InlineData("    let n = Ob.NilNested()\n    n.Num += 1", "compound member assignment")]
    [InlineData("    let (a, b) = Ob.NilPt()\n    Console.WriteLine(a + b)", "deconstruction, statement form")]

    // The SHARED prelude (ADR-0185) that a tuple-deconstructing `for … in`
    // and a destructured arrow-lambda parameter both go through. Covering
    // only the statement form would have been failure mode 1 in miniature:
    // one deconstruction path taught, its sibling not. Copilot review on
    // this PR caught it.
    [InlineData("    for (a, b) in Ob.WrapList(Ob.NilPt()) {\n        Console.WriteLine(a + b)\n    }", "deconstruction, loop prelude")]
    [InlineData("    let p = Ob.NilNest()\n    Console.WriteLine(p.Prop)", "member read (the covered control)")]
    public void Section4_TheRemainingPositions_Produce_AnAttributedFailure(string body, string site)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);
        Assert.True(compiled.Success, site + ": " + Describe(compiled));

        var failure = Assert.ThrowsAny<Exception>(
            () => world.Run(body, NullabilityMode.PlatformTypes));
        var message = Unwrap(failure).Message;
        Assert.Contains("nullability-oblivious", message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The positive controls for the fixture above: the same three shapes on
    /// a <b>non-nil</b> platform value run normally, so the inserted checks
    /// are checks and not unconditional failures.
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData("    let f = Ob.Thunk()\n    Console.WriteLine(f())", "V")]
    [InlineData("    let f = Ob.Thunk()\n    Console.WriteLine((f)())", "V")]
    [InlineData("    let n = Ob.Nest2()\n    n.Num += 1\n    Console.WriteLine(n.Num)", "1")]
    [InlineData("    let (a, b) = Ob.Pair()\n    Console.WriteLine(a + b)", "ab")]
    [InlineData("    let (a, b) = Ob.Pt2()\n    Console.WriteLine(a + b)", "ab")]
    [InlineData("    for (a, b) in Ob.WrapList(Ob.Pt2()) {\n        Console.WriteLine(a + b)\n    }", "ab")]
    public void Section4_TheRemainingPositions_Still_Run_When_NotNil(string body, string expected)
    {
        using var world = new World();

        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim());
    }

    /// <summary>
    /// <b>ADR-0186 step 4 — member lookup must not un-report a receiver the
    /// author declared nilable in G# source.</b>
    /// <para>
    /// Issue #4287's shape: a G#-declared <c>var name string?</c> field,
    /// dereferenced with no guard. The member-lookup carve-out that step 4 kept
    /// and #4356 deleted (<c>|| receiver is BoundClrPropertyAccessExpression</c>
    /// in <c>CanBindClrInstanceMember</c>) never applied here — a field read on
    /// a G#-declared class is not a CLR property access — so this must report
    /// exactly as it always has. This is the "one condition, not one block"
    /// trap the ADR names: it is the easiest way to reintroduce #4287's defect
    /// while believing the work is cleanup.
    /// </para>
    /// <para>
    /// The <b>read</b> is what is asserted, not a call. Member lookup is what
    /// <c>CanBindClrInstanceMember</c> gates; an instance <em>call</em> on a
    /// nilable receiver resolves through a different path that still reports
    /// nothing on <c>main</c> — #4287's own fix was never merged (PR #4308 was
    /// closed when this work pivoted to platform types), so that half is an
    /// open gap this step neither closes nor widens, and pinning it here would
    /// pin a defect rather than a guarantee.
    /// </para>
    /// </summary>
    [Fact]
    public void Step4_ASourceDeclaredNilableFieldReceiver_Still_Reports()
    {
        const string holder = """
            class Holder {
                var name string?

                func Len() int32 {
                    return this.name.Length
                }
            }
            """;

        using var world = new World();

        foreach (var mode in new[] { NullabilityMode.Enabled, NullabilityMode.PlatformTypes })
        {
            var compiled = world.Compile("    Console.WriteLine(\"unused\")", mode, extraDeclarations: holder);

            Assert.False(compiled.Success, Describe(compiled));
            Assert.Contains(compiled.Diagnostics, d => d.Id == "GS0158");
        }
    }

    /// <summary>
    /// <b>ADR-0186 step 4 — a source-declared nilable container still selects
    /// the instance member, not the shadowing extension.</b>
    /// <para>
    /// §5a's <c>ListReverse</c> witness aimed at a G#-declared
    /// <c>List[int32]?</c> rather than at an oblivious receiver.
    /// <c>import System.Linq</c> is load-bearing exactly as it is there:
    /// without <c>Enumerable</c> in scope there is no competing extension and
    /// the probe witnesses nothing. The failure guarded against is not a
    /// diagnostic changing shape but <c>xs.Reverse()</c> quietly becoming
    /// <c>Enumerable.Reverse</c> — lazy, copying, result discarded — on a
    /// receiver whose only difference from the baseline is its declared
    /// nullability.
    /// </para>
    /// <para>
    /// <c>SelectedReverseDeclaringType</c> tolerates a <c>GS0159</c> on the
    /// nilable probe, so this is <b>not</b> an assertion that a nilable
    /// receiver <em>should</em> call an instance method with no diagnostic.
    /// That it currently does is #4287's still-open call-path half (see
    /// <see cref="Step4_ASourceDeclaredNilableFieldReceiver_Still_Reports"/>);
    /// this test's subject is <em>which</em> method, not whether the access is
    /// reported, and it keeps passing when that half is fixed.
    /// </para>
    /// </summary>
    [Fact]
    public void Step4_ASourceDeclaredNilableContainer_Selects_TheInstanceMember()
    {
        const string nilable = """
                let xs List[int32]? = List[int32]()
                xs.Reverse()
            """;
        const string baseline = """
                let xs = List[int32]()
                xs.Reverse()
            """;

        using var world = new World();

        foreach (var mode in new[] { NullabilityMode.Enabled, NullabilityMode.PlatformTypes })
        {
            Assert.Equal(
                world.SelectedReverseDeclaringType(baseline, mode),
                world.SelectedReverseDeclaringType(nilable, mode, tolerateNilableReceiverReport: true));
        }
    }

    /// <summary>
    /// <b>ADR-0186 step 4 — the <c>StringTrim</c> half of the same gate, on a
    /// source-declared <c>string?</c>.</b>
    /// <para>
    /// The ADR's step-4 sequencing names two witnesses for a source-declared
    /// nilable receiver: <c>ListReverse</c>
    /// (<see cref="Step4_ASourceDeclaredNilableContainer_Selects_TheInstanceMember"/>)
    /// and this one. The competing member here is
    /// <c>MemoryExtensions.Trim(this ReadOnlySpan&lt;char&gt;)</c>, reachable
    /// from a <c>string</c> by the implicit span conversion and in scope
    /// through <c>import System</c>. The silent failure is <c>s.Trim()</c>
    /// retyping to <c>ReadOnlySpan&lt;char&gt;</c> on a receiver whose only
    /// difference from the baseline is its declared nullability, so the
    /// assertion is on the bound result TYPE, which is what distinguishes the
    /// two — running the probe would not, since both print the same text.
    /// </para>
    /// <para>
    /// As with the <c>ListReverse</c> witness, the nilable probe is bound with
    /// <c>tolerateNilableReceiverReport</c>, so this is not an assertion that an
    /// instance call on a nilable receiver <em>should</em> go unreported
    /// (#4287's open call-path half).
    /// </para>
    /// </summary>
    [Fact]
    public void Step4_ASourceDeclaredNilableString_Trim_Stays_TheStringInstanceMember()
    {
        const string nilable = """
            let s string? = "  a  "
            let probe = s.Trim()
            """;
        const string baseline = """
            let s = "  a  "
            let probe = s.Trim()
            """;

        using var world = new World();

        foreach (var mode in new[] { NullabilityMode.Enabled, NullabilityMode.PlatformTypes })
        {
            var expected = world.GlobalProbeType(baseline, mode);
            var actual = world.GlobalProbeType(nilable, mode, tolerateNilableReceiverReport: true);

            Assert.Equal(typeof(string), expected.ClrType);
            Assert.Equal(expected.ClrType, actual.ClrType);
        }
    }

    /// <summary>
    /// <b>Issue #4356 — a member chain through an ANNOTATED-nullable imported
    /// member reports, reads and writes alike.</b>
    /// <para>
    /// <c>CanBindClrInstanceMember</c> used to carry a second disjunct,
    /// <c>|| receiver is BoundClrPropertyAccessExpression</c>, that let a chain
    /// continue through any imported field or property read typed <c>T?</c>.
    /// Its purpose (#2459) was oblivious members, which ADR-0186 now imports as
    /// <c>T!</c>; what it still admitted was a member the library author
    /// explicitly annotated <c>T?</c> (<c>[Nullable(2)]</c>), dereferenced with
    /// no narrowing and no nil check. ADR-0186 step 4 kept it because cs2gs
    /// output depended on it; #4356 fixed cs2gs and deleted it. An annotated
    /// <c>T?</c> read now needs the same proof a source-declared <c>T?</c>
    /// always did.
    /// </para>
    /// <para>
    /// Both call sites are covered — the read path and
    /// <c>BindMemberFieldAssignmentExpression</c>'s CLR-receiver arm — in both
    /// modes, against the purpose-built annotated fixture and against the real
    /// annotated BCL. The remedies (<c>!!</c>, <c>?.</c>, an <c>if let</c>
    /// narrowing) are compiled and <em>run</em>, and the receiver's static type
    /// is asserted to stay <c>T?</c>: ADR-0186 leaves annotated members as they
    /// are, this only stops member lookup from ignoring what they say.
    /// </para>
    /// </summary>
    [Fact]
    public void Issue4356_AChainThroughAnAnnotatedNullableClrMember_Reports()
    {
        const string fixtureRead = """
                let a = Annotated()
                Console.WriteLine(a.MaybeText.Length)
            """;
        const string bclRead = """
                let e = Exception("outer", InvalidOperationException("inner"))
                Console.WriteLine(e.InnerException.Message)
            """;
        const string fixtureWrite = """
                let a = Annotated()
                a.MaybeNumbers.Capacity = 4
            """;
        const string bclWrite = """
                let e = Exception("outer", InvalidOperationException("inner"))
                e.InnerException.Source = "src"
            """;
        const string remedies = """
                let a = Annotated()
                a.MaybeNumbers!!.Capacity = 4
                Console.WriteLine(a.MaybeNumbers!!.Capacity)
                let e = Exception("outer", InvalidOperationException("inner"))
                e.InnerException!!.Source = "src"
                Console.WriteLine(e.InnerException?.Source)
                if let inner = e.InnerException {
                    Console.WriteLine(inner.Message)
                }
            """;

        using var world = new World();

        foreach (var mode in new[] { NullabilityMode.Enabled, NullabilityMode.PlatformTypes })
        {
            foreach (var (body, member) in new[]
                {
                    (fixtureRead, "Length"),
                    (bclRead, "Message"),
                    (fixtureWrite, "Capacity"),
                    (bclWrite, "Source"),
                })
            {
                var compiled = world.Compile(body, mode);
                Assert.False(compiled.Success, body);
                Assert.Contains(
                    compiled.Diagnostics,
                    d => d.Id == "GS0158" && d.Message.Contains(member, StringComparison.Ordinal));
            }

            Assert.Equal(
                new[] { "4", "src", "inner" },
                world.Run(remedies, mode).Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries));

            Assert.IsType<NullableTypeSymbol>(world.GlobalProbeType("let probe = Annotated().MaybeText", mode));
        }
    }

    /// <summary>
    /// <b>Issue #4356 — a nullable type argument substituted into a plain
    /// generic member reports too.</b>
    /// <para>
    /// <c>Box&lt;T&gt;.Value</c> and <c>.Field</c> are declared plain
    /// <c>T</c>, with no <c>[Nullable(2)]</c>. On a <c>Box[List[int32]?]</c>
    /// receiver the member lookup keeps the receiver-supplied <c>?</c>
    /// (<c>NullableFlagsBuilder.MergeDeclarationNullability</c>), so the read
    /// is <c>T?</c> — nullability the G# author wrote in source. It used to
    /// continue its chain through the same deleted disjunct because the read is
    /// a <c>BoundClrPropertyAccessExpression</c>; it now needs the same proof
    /// any <c>T?</c> does.
    /// </para>
    /// </summary>
    [Fact]
    public void Issue4356_AChainThroughANullableGenericSubstitution_Reports()
    {
        const string read = """
                let b = Box[List[int32]?]()
                b.Value = List[int32]()
                Console.WriteLine(b.Value.Capacity)
            """;
        const string write = """
                let b = Box[List[int32]?]()
                b.Field = List[int32]()
                b.Field.Capacity = 5
            """;
        const string remedies = """
                let b = Box[List[int32]?]()
                b.Value = List[int32]()
                b.Field = List[int32]()
                b.Value!!.Capacity = 4
                b.Field!!.Capacity = 5
                Console.WriteLine(b.Value!!.Capacity)
                Console.WriteLine(b.Field?.Count)
            """;

        using var world = new World();

        foreach (var mode in new[] { NullabilityMode.Enabled, NullabilityMode.PlatformTypes })
        {
            foreach (var (body, member) in new[] { (read, "Capacity"), (write, "Capacity") })
            {
                var compiled = world.Compile(body, mode);
                Assert.False(compiled.Success, body);
                Assert.Contains(
                    compiled.Diagnostics,
                    d => d.Id == "GS0158" && d.Message.Contains(member, StringComparison.Ordinal));
            }

            Assert.Equal(
                new[] { "4", "0" },
                world.Run(remedies, mode).Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries));
            Assert.IsType<NullableTypeSymbol>(world.GlobalProbeType("let b = Box[List[int32]?]()\nlet probe = b.Value", mode));
        }
    }

    /// <summary>
    /// <b>ADR-0186 step 4 — the discriminator: an OBLIVIOUS field-read
    /// receiver is checked, not waved through.</b>
    /// <para>
    /// <c>Ob.ArrField</c> and <c>Ob.NilNestField</c> are imported <em>field
    /// reads</em> — the receiver kind the deleted carve-out used to admit —
    /// over nullability-oblivious metadata, and deliberately not locals.
    /// </para>
    /// <para>
    /// Under the default mode the receiver is <c>T!</c>, a §4 check is
    /// inserted for it, and a nil one throws the attributed
    /// <c>NullReferenceException</c>: the platform coercion answers its safety
    /// question. The stated-nullable counterparts in
    /// <see cref="Issue4356_AChainThroughAnAnnotatedNullableClrMember_Reports"/>
    /// and <see cref="Issue4356_AChainThroughANullableGenericSubstitution_Reports"/>
    /// are the other half: <c>T?</c>, reported.
    /// </para>
    /// <para>
    /// Under <c>--nullability=enabled</c> the same field is ADR-0136's
    /// <c>string[]?</c>. Before #4356 it bound through the carve-out; it now
    /// reports like any <c>T?</c> receiver, which is what ADR-0136 always said
    /// it should do, and <c>!!</c> is the remedy there.
    /// </para>
    /// </summary>
    [Fact]
    public void Step4_AnObliviousFieldReadReceiver_Is_Checked_Not_WavedThrough()
    {
        const string body = """
                Console.WriteLine(Ob.ArrField.Length)
            """;
        const string nilBody = """
                Console.WriteLine(Ob.NilNestField.Prop)
            """;

        using var world = new World();

        Assert.IsType<PlatformTypeSymbol>(world.GlobalProbeType("let probe = Ob.ArrField", NullabilityMode.PlatformTypes));
        Assert.Equal(1, world.CountPlatformChecks(body));
        Assert.Equal("1", world.Run(body, NullabilityMode.PlatformTypes).Trim());

        var thrown = Assert.Throws<NullReferenceException>(
            () => world.Run(nilBody, NullabilityMode.PlatformTypes));
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal);

        Assert.IsType<NullableTypeSymbol>(world.GlobalProbeType("let probe = Ob.ArrField", NullabilityMode.Enabled));
        var enabled = world.Compile(body, NullabilityMode.Enabled);
        Assert.False(enabled.Success, Describe(enabled));
        Assert.Contains(enabled.Diagnostics, d => d.Id == "GS0158" && d.Message.Contains("Length", StringComparison.Ordinal));
        Assert.Equal("1", world.Run("    Console.WriteLine(Ob.ArrField!!.Length)", NullabilityMode.Enabled).Trim());
    }

    /// <summary>Unwraps the reflection/target-invocation wrappers a run adds.</summary>
    /// <param name="failure">The thrown exception.</param>
    /// <returns>The innermost exception.</returns>
    private static Exception Unwrap(Exception failure)
    {
        var current = failure;
        while (current.InnerException is { } inner)
        {
            current = inner;
        }

        return current;
    }

    private const string NilHelpers = """
        func takesString(s string) {
            Console.WriteLine(s)
        }

        func takesNilable(s string?) {
            Console.WriteLine("nilable")
        }

        func returnsString() string {
            return Ob.Nil()
        }
        """;

    private static string Describe(CompiledProgram compiled)
        => string.Join(Environment.NewLine, compiled.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private sealed record DiagnosticLine(string Id, string Message);

    private sealed record CompiledProgram(bool Success, IReadOnlyList<DiagnosticLine> Diagnostics, byte[] PeBytes);

    /// <summary>
    /// The oblivious library plus the machinery to compile and run a G# probe
    /// against it in either nullability mode.
    /// </summary>
    private sealed class World : IDisposable
    {
        private readonly string directory;

        internal World()
        {
            this.directory = Path.Combine(
                AppContext.BaseDirectory,
                nameof(Adr0186PlatformTypeBindingTests),
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.directory);
            this.LibraryPath = EmitCSharpLibrary(this.directory, Library, LibrarySource);
        }

        internal string LibraryPath { get; }

        /// <summary>Gets the display string of the last <see cref="GlobalProbeType"/> result.</summary>
        internal string LastProbeDisplay { get; private set; } = string.Empty;

        public void Dispose()
        {
            try
            {
                Directory.Delete(this.directory, recursive: true);
            }
            catch (IOException)
            {
                // A locked assembly on a test host is not a test failure.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        internal CompiledProgram Compile(
            string body,
            NullabilityMode mode,
            string extraDeclarations = "",
            bool platformNilChecks = true)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, extraDeclarations))))
            {
                AssemblyName = Consumer,
                Nullability = mode,
                PlatformNilChecks = platformNilChecks,
            };

            using var pe = new MemoryStream();
            var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: Consumer);
            return new CompiledProgram(
                emit.Success,
                emit.Diagnostics.Select(d => new DiagnosticLine(d.Id, d.Message)).ToArray(),
                emit.Success ? pe.ToArray() : Array.Empty<byte>());
        }

        internal string Run(
            string body,
            NullabilityMode mode,
            string extraDeclarations = "",
            bool platformNilChecks = true)
        {
            var compiled = this.Compile(body, mode, extraDeclarations, platformNilChecks);
            Assert.True(compiled.Success, Describe(compiled));

            var context = new AssemblyLoadContext(
                nameof(Adr0186PlatformTypeBindingTests) + "-" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            // Load the oblivious library from BYTES, not from its path, so the
            // file stays deletable: a path load keeps the DLL locked until the
            // collectible context finishes unloading, `Dispose` then fails to
            // delete the directory, and the swallowed failure leaks one
            // workspace per test case. This mirrors `EmittedFixture.Load`'s
            // existing comment, which is there for the same reason.
            var libraryImage = File.ReadAllBytes(this.LibraryPath);
            context.Resolving += (loadContext, name) =>
                string.Equals(name.Name, Library, StringComparison.Ordinal)
                    ? loadContext.LoadFromStream(new MemoryStream(libraryImage))
                    : null;

            try
            {
                using var peStream = new MemoryStream(compiled.PeBytes);
                var assembly = context.LoadFromStream(peStream);
                var entry = Invariant.Required(assembly.EntryPoint, "an emitted G# program has an entry point");

                var stdout = Console.Out;
                var captured = new StringWriter();
                Console.SetOut(captured);
                try
                {
                    entry.Invoke(
                        null,
                        entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                }
                catch (TargetInvocationException invocation) when (invocation.InnerException != null)
                {
                    // Surface the program's own exception, not the reflection
                    // wrapper — the §4 fixtures assert on its message.
                    throw invocation.InnerException;
                }
                finally
                {
                    Console.SetOut(stdout);
                }

                return captured.ToString();
            }
            finally
            {
                context.Unload();
            }
        }

        /// <summary>
        /// Binds <paramref name="globals"/> as top-level statements and
        /// returns the inferred type of its <c>probe</c> global — the §5b
        /// observation, which has to read a TYPE and so cannot be made by
        /// running anything.
        /// </summary>
        /// <param name="globals">Top-level G# statements declaring <c>probe</c>.</param>
        /// <param name="mode">The nullability mode.</param>
        /// <param name="tolerateNilableReceiverReport">
        /// Accept a <c>GS0159</c> in the probe — see
        /// <see cref="IsToleratedNilableReceiverReport"/>.
        /// </param>
        /// <returns>The bound type of <c>probe</c>.</returns>
        internal TypeSymbol GlobalProbeType(string globals, NullabilityMode mode, bool tolerateNilableReceiverReport = false)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var source = $$"""
                package {{Consumer}}
                import Adr0186.Step2.Library
                import System
                import System.Collections.Generic
                import System.Linq

                class Entry {
                    var Id int32 = 1
                }

                {{globals}}
                """;
            var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            {
                AssemblyName = Consumer,
                Nullability = mode,
            };

            var scope = compilation.GlobalScope;
            Assert.DoesNotContain(
                scope.Diagnostics,
                d => d.IsError && !(tolerateNilableReceiverReport && IsToleratedNilableReceiverReport(d)));
            var type = Assert.Single(scope.Variables, v => v.Name == "probe").Type;

            // Rendered while the metadata context is still alive: an imported
            // type's display reads its CLR shape, which is gone once
            // `resolver` is disposed.
            this.LastProbeDisplay = GSharp.Core.CodeAnalysis.Symbols.Display.SymbolDisplay.ToTypeDisplayString(type);
            return type;
        }

        /// <summary>
        /// Counts the ADR-0186 §4 checks the binder synthesized in
        /// <paramref name="body"/>. A synthesized check is the only one
        /// carrying a <c>PlatformCheckMessage</c>, so this counts exactly the
        /// coercions §4 inserted and never a user-written <c>!!</c>.
        /// </summary>
        /// <param name="body">The probe body.</param>
        /// <returns>The number of inserted checks.</returns>
        internal int CountPlatformChecks(string body)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, string.Empty))))
            {
                AssemblyName = Consumer,
                Nullability = NullabilityMode.PlatformTypes,
            };

            var program = compilation.BoundProgram;
            Assert.DoesNotContain(program.Diagnostics, d => d.IsError);

            var counter = new PlatformCheckCounter();
            foreach (var function in program.Functions)
            {
                counter.Visit(function.Value);
            }

            return counter.Count;
        }

        /// <summary>Counts synthesized ADR-0186 §4 checks in a bound body.</summary>
        private sealed class PlatformCheckCounter : BoundTreeWalker
        {
            internal int Count { get; private set; }

            protected override void VisitUnaryExpression(BoundUnaryExpression node)
            {
                if (node.PlatformCheckMessage != null)
                {
                    this.Count++;
                }

                base.VisitUnaryExpression(node);
            }
        }

        /// <summary>
        /// Binds <paramref name="body"/> and reports the declaring type of the
        /// method a <c>Reverse()</c> call selected — §5a's structural half.
        /// </summary>
        /// <param name="body">The probe body containing exactly one <c>Reverse()</c> call.</param>
        /// <param name="mode">The nullability mode.</param>
        /// <param name="tolerateNilableReceiverReport">
        /// Accept a <c>GS0159</c> in the probe — see
        /// <see cref="IsToleratedNilableReceiverReport"/>. Only a nilable probe
        /// should pass <see langword="true"/>.
        /// </param>
        /// <returns>The selected method's declaring type name.</returns>
        internal string SelectedReverseDeclaringType(string body, NullabilityMode mode, bool tolerateNilableReceiverReport = false)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, string.Empty))))
            {
                AssemblyName = Consumer,
                Nullability = mode,
            };

            // Opt-in, for a NILABLE probe only: its call is allowed to be
            // REPORTED, because this helper's subject is which method was
            // selected and #4287's still-open call-path half would add exactly
            // that report once fixed. Baselines and platform probes stay
            // strict, so a regression that makes THEM report is still caught.
            var program = compilation.BoundProgram;
            Assert.DoesNotContain(
                program.Diagnostics,
                d => d.IsError && !(tolerateNilableReceiverReport && IsToleratedNilableReceiverReport(d)));

            var collector = new ReverseCallCollector();
            foreach (var function in program.Functions)
            {
                collector.Visit(function.Value);
            }

            return Assert.Single(collector.Found);
        }

        /// <summary>
        /// Whether <paramref name="diagnostic"/> is the report an instance
        /// call on a nilable receiver would carry once #4287's call-path half
        /// is fixed (PR #4308 reported it as <c>GS0159</c>). The selection
        /// witnesses tolerate it so they assert only which member was chosen,
        /// not that the call goes unreported — pinning the latter would pin
        /// the open defect.
        /// </summary>
        /// <param name="diagnostic">A binder diagnostic.</param>
        /// <returns><see langword="true"/> for a <c>GS0159</c>.</returns>
        private static bool IsToleratedNilableReceiverReport(GSharp.Core.CodeAnalysis.Diagnostic diagnostic)
            => diagnostic.Id == "GS0159";

        /// <summary>
        /// Finds the declaring type of every <c>Reverse</c> call in a bound
        /// body. Both call shapes are collected on purpose: an own-surface
        /// instance call binds as <c>BoundImportedInstanceCallExpression</c>
        /// and an extension binds as <c>BoundClrStaticCallExpression</c>, so
        /// a collector that looked at only one would report "no call found"
        /// rather than "the wrong method" when §5a regresses.
        /// </summary>
        private sealed class ReverseCallCollector : BoundTreeWalker
        {
            internal List<string> Found { get; } = new();

            protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
            {
                if (node.Method.Name == "Reverse")
                {
                    this.Found.Add(node.Method.DeclaringType?.FullName ?? "<unknown>");
                }

                base.VisitImportedInstanceCallExpression(node);
            }

            protected override void VisitClrStaticCallExpression(BoundClrStaticCallExpression node)
            {
                if (node.Method.Name == "Reverse")
                {
                    this.Found.Add(node.Method.DeclaringType?.FullName ?? "<unknown>");
                }

                base.VisitClrStaticCallExpression(node);
            }
        }

        private static string BuildSource(string body, string extraDeclarations)
            => $$"""
                package {{Consumer}}
                import Adr0186.Step2.Library
                import System
                import System.Collections.Generic
                import System.Linq
                import System.Linq.Expressions

                func Main() {
                {{body}}
                }

                {{extraDeclarations}}
                """;

        private static string EmitCSharpLibrary(string directory, string assemblyName, string source)
        {
            var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                    ?.Split(Path.PathSeparator) ?? Array.Empty<string>())
                .Where(File.Exists)
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create(
                assemblyName,
                new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            var path = Path.Combine(directory, assemblyName + ".dll");
            using var stream = File.Create(path);
            var emit = compilation.Emit(stream);
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
            return path;
        }
    }
}
