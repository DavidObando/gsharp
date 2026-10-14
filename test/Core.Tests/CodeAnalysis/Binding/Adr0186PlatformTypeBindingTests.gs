// <copyright file="Adr0186PlatformTypeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsConversion = GSharp.Core.CodeAnalysis.Binding.Conversion
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis.Symbols.Display

/// ADR-0186 step 2, end to end: §3's conversions and generic-container rule,
/// §4's coercion check, §5's two-clause lookup invariant, and §6's operator
/// acceptance — all against <b>real csc-emitted oblivious metadata</b> rather
/// than synthesized symbols, because the whole design turns on what an
/// unannotated assembly actually says.
///
/// Every case runs in <b>both</b> modes. The `Enabled` column is not
/// decoration: ADR-0186's sequencing makes "no behaviour change while
/// `--nullability=platform-types` is off" the load-bearing claim of every
/// step before the default flips, and a test that only exercises the new mode
/// cannot see a regression in the old one.
partial class Adr0186PlatformTypeBindingTests {
    /// <b>ADR-0186 §5a — the mutation witness, first half.</b>
    ///
    /// This is the test the ADR names as required, and it witnesses the single
    /// most important property in the design: <em>a receiver's platform-ness
    /// cannot select a different member.</em> Failure mode 5 of the catalogue
    /// (commit `359538cd`) was a silent miscompile in which one source
    /// line, `xs.Reverse()`, bound `List<T>.Reverse` for a
    /// plain receiver (void, in place, first element becomes 3) and
    /// `Enumerable.Reverse` for a nilable one (lazy, copying, result
    /// discarded, first element stays 1) — same line, opposite runtime
    /// meaning, chosen purely by the receiver's static nullability, with no
    /// diagnostic either way.
    ///
    /// <b>
    /// <c>import System.Linq</c> is load-bearing and deliberate.</b> Commit
    /// `359538cd` records why: without `Enumerable` in scope there
    /// is no competing extension, the test passes either way, and it witnesses
    /// nothing at all.
    ///
    /// The assertion is the <em>mutation</em>, observed by running the emitted
    /// assembly, because that is what distinguishes the two candidates —
    /// binding successfully proves nothing here, since both candidates bind.
    @Fact
    func Section5a_APlatformReceiver_Selects_The_Same_Member_And_Produces_The_Same_Mutation() {
        const body = `    let xs = Ob.Numbers()
    xs.Reverse()
    Console.WriteLine(xs[0])`
        // The `T` baseline: a G#-declared `List[int32]` receiver, which has
        // never been in any doubt.
        const baseline = `    let xs = List[int32]()
    xs.Add(1)
    xs.Add(2)
    xs.Add(3)
    xs.Reverse()
    Console.WriteLine(xs[0])`
        using let world = World()
        let baselineOutput = world.Run(baseline, NullabilityMode.Enabled)
        Assert.Equal("3", baselineOutput.Trim())
        // The witness: the SAME line against a platform receiver must produce
        // the same mutation. `Enumerable.Reverse` would print 1.
        let platformOutput = world.Run(body, NullabilityMode.PlatformTypes)
        Assert.Equal("3", platformOutput.Trim())
        // And the selection itself, asserted structurally rather than only
        // through its effect: the bound call names `List<T>.Reverse`, not
        // `Enumerable.Reverse`. A witness that only observed the mutation
        // would stay green if some future change made `Enumerable.Reverse`
        // mutate-and-return, which is exactly the kind of coincidence
        // ADR-0154 asks a witness not to rely on.
        Assert.Equal(
            world.SelectedReverseDeclaringType(baseline, NullabilityMode.Enabled),
            world.SelectedReverseDeclaringType(body, NullabilityMode.PlatformTypes)
        )
    }

    /// <b>ADR-0186 §5b — the mutation witness, second half.</b>
    ///
    /// §5's invariant has two clauses and the ADR is explicit that an earlier
    /// draft stated only the first: "a witness that checks only selection
    /// passes while §5b is broken." Selection constrains <em>which</em> member
    /// is chosen; it says nothing about <em>what type the expression has
    /// afterwards</em>.
    ///
    /// The named hazard: `MemberLookup.GetImportedTypeSymbol` is a closed
    /// switch over receiver type symbols with no `PlatformTypeSymbol`
    /// arm. Reached with one it falls through to the erased answer at each of
    /// its call sites, turning `Queue[Entry]!.Dequeue()` from
    /// `Entry` into a CLR erasure. The fix ADR-0186 prescribes — and
    /// which this test pins — is to unwrap `T!` to `T` <em>before</em>
    /// type resolution runs, on the path resolution already uses, rather than
    /// teaching each of the eleven consumers about the new wrapper.
    ///
    /// `Entry` is a <b>same-compilation G# class</b> on purpose. An
    /// imported element type survives erasure by accident (reflection resolves
    /// it anyway); a same-compilation type has no runtime `Type` during
    /// binding, so the erased path yields `object` and the symbolic path
    /// yields `Entry`. Only the same-compilation shape discriminates.
    @Fact
    func Section5b_APlatformReceiver_Produces_The_Same_Result_Type_For_A_Symbolic_Call() {
        using let world = World()
        // Baseline: the receiver is an ordinary `Queue[Entry]` built in G#.
        let baseline = world.GlobalProbeType(
            "let queue = Queue[Entry]()\nlet probe = queue.Dequeue()",
            NullabilityMode.Enabled
        )
        // Witness: the receiver is `Queue[Entry]!` — the oblivious library
        // returns it, so it arrives platform-wrapped.
        let platform = world.GlobalProbeType(
            "let probe = Ob.Wrap[Entry](Entry()).Dequeue()",
            NullabilityMode.PlatformTypes
        )
        Assert.Equal("Entry", baseline.Name)
        // #4451 (ADR-0193 amendment): the explicit `[Entry]` at the oblivious
        // `Wrap<T>` slot binds `T = Entry!`, so the element read is `Entry!`.
        // §5b is about the UNDERLYING type, which must still be the symbolic
        // `Entry`, not an erasure.
        let platformElement = Assert.IsType[PlatformTypeSymbol](platform)
        // The load-bearing assertion. With §5b broken this reads "object".
        Assert.Equal(baseline.Name, platformElement.UnderlyingType.Name)
        Assert.DoesNotContain("object", platformElement.UnderlyingType.Name, StringComparison.Ordinal)
    }

    /// ADR-0186 §3 rule 3 — the generic-container soundness fix (Copilot
    /// finding HIGH-2 against the ADR), in both directions.
    ///
    /// An earlier draft made `Box[string!]`, `Box[string]` and
    /// `Box[string?]` mutually assignable, reasoning that all three erase
    /// to one CLR type so nothing is observable at runtime. <b>Erasure is
    /// precisely what makes the hole reachable</b>: two views alias one
    /// object, so a nil written through one view is read as non-null through
    /// the other with <b>no <c>T! → T</c> boundary crossed anywhere</b> and
    /// therefore no §4 check.
    ///
    /// Exactly one conversion survives, `C[T!] → C[T?]`, and it is sound
    /// because every read through the destination view has type `T?` and
    /// must be narrowed before non-null use.
    @Fact
    func Section3_AGenericContainer_Converts_Only_From_Platform_To_Nilable() {
        using let world = World()
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
        let toNonNull = world.Compile(
            "    let alias List[string] = Ob.NilStrings()\n    Console.WriteLine(alias[0])",
            NullabilityMode.PlatformTypes
        )
        Assert.False(toNonNull.Success, Describe(toNonNull))
        // Issue #4361: the diagnostic names the nested `!` — before, both
        // sides printed as `List[string]` and the message read "Cannot convert
        // X to X".
        Assert.Contains(
            toNonNull.Diagnostics,
            (d DiagnosticLine) -> d.Message.Contains("List[string!]!", StringComparison.Ordinal)
        )
        // The one legal direction.
        let toNilable = world.Compile(
            "    let alias List[string?] = Ob.NilStrings()\n    Console.WriteLine(alias.Count)",
            NullabilityMode.PlatformTypes
        )
        Assert.True(toNilable.Success, Describe(toNilable))
        // The two remaining unsound directions — `C[T] -> C[T!]` and
        // `C[T?] -> C[T!]` — have no source spelling to test here, because
        // `T!` is unwritable (§1) and no G# declaration can name a
        // platform-argument parameter before §9's oblivious scope lands. They
        // are pinned at the classifier instead, in
        // `Adr0186PlatformTypeConversionTests`, where both constructed types
        // can be built directly.

    }

    /// ADR-0186 §6: a guarded access yields a plain `U?`, never
    /// `U!?`.
    ///
    /// When the accessed member is itself oblivious, the null-conditional
    /// result lifting was wrapping the platform type instead of its
    /// underlying, producing `Nullable(Platform(U))`. That is not a
    /// cosmetic difference: `U!?` is a nullable over a platform type,
    /// so platform-ness survived a guarded access and leaked into everything
    /// downstream — narrowing, `??`, `if let` — none of which
    /// expects to find a wrapper underneath the `?`.
    ///
    /// Fixed at `NullableTypeSymbol.Get` rather than at the three
    /// lifting sites that had the bug, because `T!?` is not a type this
    /// language has at all: by §3's governing principle an explicit
    /// statement beats the absence of one, which is the same rule that makes
    /// lub(`T!`, `T?`) be `T?`.
    /// @param globals A probe declaring `probe`.
    @Theory
    @InlineData("let probe = Ob.NilNest()?.Prop")
    @InlineData("let probe = Ob.TableWithNil()?[\"k\"]")
    func Section6_AGuardedAccess_Yields_APlainNullable(globals string) {
        using let world = World()
        let result = world.GlobalProbeType(globals, NullabilityMode.PlatformTypes)
        let nullable = Assert.IsType[NullableTypeSymbol](result)
        Assert.Equal("string?", nullable.Name)
        Assert.IsNotType[PlatformTypeSymbol](nullable.UnderlyingType)
    }

    /// ADR-0186 §6: the result of `??` over a platform left operand is
    /// the non-null underlying, not `T!`.
    ///
    /// Supplying a fallback is precisely the act that removes the doubt, so a
    /// result still typed `T!` claims the compiler does not know
    /// something the expression has just guaranteed — and drags a spurious
    /// `T! -> T` check, plus §3's overload tie-break, into every use
    /// downstream of it.
    @Fact
    func Section6_Coalescing_APlatformOperand_Yields_TheNonNullUnderlying() {
        using let world = World()
        let result = world.GlobalProbeType("let probe = Ob.Value() ?? \"fallback\"", NullabilityMode.PlatformTypes)
        Assert.IsNotType[PlatformTypeSymbol](result)
        Assert.IsNotType[NullableTypeSymbol](result)
        Assert.Equal("string", result.Name)
    }

    /// ADR-0186 §4 inside an expression-tree lambda: a <b>receiver</b> check
    /// is elided, and every other platform coercion is still rejected.
    ///
    /// §4 names the elision itself: "The CLR's own check on a
    /// `callvirt`/`ldfld` receiver makes the inserted check
    /// redundant where it fires, which is a reason to <b>elide</b> it as an
    /// optimization." Inside an expression-tree lambda gsc emits no IL — the
    /// access becomes `Expression.Property` or a call node — and
    /// `System.Linq.Expressions` dereferences the instance when the tree
    /// is evaluated, throwing at the same point. The failure survives; only
    /// G#'s message is lost, which is the residual tracked as <b>#4352</b>.
    ///
    /// <b>This is the narrow half of a change review was right to push back
    /// on.</b> Step 3 first removed the rejection outright, which silently
    /// dropped checks §4 and the release note both promise. What forced the
    /// question is that rejecting <em>receivers</em> is a build break on
    /// ordinary code: any oblivious reference member touched inside a
    /// LINQ-to-`IQueryable` lambda inserts one, so
    /// `Issue2661ExpressionTreeNullablePipelineTests`' `.Where(b ->
    /// b.Conversion.AccountId == id)` stopped compiling the moment the
    /// default flipped. Eliding a receiver check is also not a regression:
    /// under ADR-0136 that receiver is `T?`, cs2gs writes an explicit
    /// `!!`, and the same lowering erases it.
    /// @param body The probe body.
    @Theory
    @InlineData("    let e Expression[Func[int32]] = () -> Ob.Nest2().Num\n    Console.WriteLine(e)")
    @InlineData("    let e Expression[Func[string?]] = () -> Ob.Nest2().Prop\n    Console.WriteLine(e)")
    @InlineData("    let e Expression[Func[int32]] = () -> Ob.WrapList(\"a\").Count\n    Console.WriteLine(e)")
    func Section4_APlatformReceiverCheck_InsideAnExpressionTreeLambda_Is_Elided(body string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes, extraDeclarations: string.Empty)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.DoesNotContain(compiled.Diagnostics, (d DiagnosticLine) -> d.Id == "GS0473")
    }

    /// The other half, and the control that keeps the elision above honest: a
    /// platform coercion inside an expression-tree lambda that is <b>not</b> a
    /// receiver is still `GS0473`.
    ///
    /// Nothing dereferences a lambda's own result, so erasing the check there
    /// would lose the failure entirely rather than merely its message —
    /// exactly what §4 forbids and what review objected to.
    /// `System.Linq.Expressions` has no throw-on-nil-and-yield form that
    /// preserves G#'s contract <em>and</em> survives translation by a real
    /// `IQueryable` provider, so rejection remains the honest answer
    /// until #4352 chooses one.
    /// @param body The probe body.
    /// @param site What the row covers.
    @Theory
    @InlineData(
        "    let e Expression[Func[string]] = () -> Ob.Value()!!\n    Console.WriteLine(e)",
        "an explicit '!!' on the result"
    )
    @InlineData(`    let e Expression[Func[int32]] = () -> Ob.Value().Length
    let f Expression[Func[string]] = () -> string.Concat(Ob.Value()!!, "x")
    Console.WriteLine(f)`, "an argument to a non-null parameter")
    func Section4_ANonReceiverPlatformCoercion_InAnExpressionTreeLambda_Is_Rejected(body string, site string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes, extraDeclarations: string.Empty)
        Assert.False(compiled.Success, site + ": " + Describe(compiled))
        Assert.Contains(
            compiled.Diagnostics,
            (d DiagnosticLine) -> d.Id == "GS0473" && d.Message.Contains(
                "nullability-oblivious",
                StringComparison.Ordinal
            )
        )
    }

    /// The second control: the validator's <em>other</em> rejection — a
    /// `!!` stripping a nullable VALUE type (issue #3349) — is untouched.
    /// `T? → T` over a value type is a real CLR conversion with no
    /// `System.Linq.Expressions` counterpart preserving G#'s
    /// throw-on-nil contract, and ADR-0186 §2 excludes value types entirely.
    @Fact
    func Section4_ANullableValueTypeAssertion_InAnExpressionTreeLambda_Is_Still_Rejected() {
        using let world = World()
        let compiled = world.Compile(`    let n int32? = 1
    let e Expression[Func[int32]] = () -> n!!
    Console.WriteLine(e)`, NullabilityMode.PlatformTypes, extraDeclarations: string.Empty)
        Assert.False(compiled.Success, Describe(compiled))
        Assert.Contains(compiled.Diagnostics, (d DiagnosticLine) -> d.Id == "GS0473")
    }

    /// ADR-0186 §3 rule 3, for <b>magic collections</b> — the shape the first
    /// version of the container arm missed entirely, and the one place this
    /// step was measurably <em>worse</em> than the model it replaces.
    ///
    /// An oblivious `string[]` arrives as `[]string!`: the wrapper
    /// sits on the container and the element's obliviousness lives in the
    /// reader's nullable-flags subtree, where rule 5 makes a read yield
    /// `string!` (pinned below). Assigning it into a bare
    /// `[]string` is therefore `C[T!] -> C[T]` in substance, and
    /// rule 3 gives that no conversion.
    ///
    /// <b>Before the fix this compiled with no check at all.</b> The
    /// container check fired and passed — the array is not nil — and the
    /// conversion then erased the element's platform-ness, so
    /// `b[0].Length` threw an unattributed `NullReferenceException`
    /// on a program the pre-ADR-0186 model <em>rejects</em>. Incompleteness
    /// in a new rule turning into a strictness regression is the worst
    /// available outcome, and it is why this fixture exists separately from
    /// the generic-container one.
    ///
    /// Rejection, not a check, is the fix: rule 3 says the conversion does
    /// not exist, and rejecting restores parity with the current model.
    /// @param body The probe body.
    /// @param site What the row covers.
    @Theory
    @InlineData(`    let a = Ob.ArrWithNil()
    let b []string = a
    Console.WriteLine(b[0].Length)`, "through an inferred local")
    @InlineData(
        "    let b []string = Ob.ArrWithNil()\n    Console.WriteLine(b[0].Length)",
        "directly at the declared slot"
    )
    @InlineData(
        "    let b []string = Ob.NilArr()\n    Console.WriteLine(b.Length)",
        "with a nil container too - rule 3 does not care"
    )
    @InlineData(
        "    let s sequence[string] = Ob.ArrWithNil()\n    Console.WriteLine(s)",
        "through a supertype view (#4420)"
    )
    func Section3_AMagicCollection_Is_Not_Exempt_From_The_Container_Rule(body string, site string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.False(compiled.Success, site + ": " + Describe(compiled))
        // A platform array OF platform elements, in ADR-0132's positional
        // spelling (issue #4361's display fix — it used to print `[]string!`,
        // which is the spelling of a plain slice of platform elements).
        Assert.Contains(
            compiled.Diagnostics,
            (d DiagnosticLine) -> d.Message.Contains("[]!string!", StringComparison.Ordinal)
        )
    }

    /// The negative control for the fixture above, and the constraint that
    /// makes it safe: a pair the container rule cannot compare is
    /// <b>declined</b>, never rejected. Widening a platform slice to
    /// `object` is an ordinary upcast and has nothing to do with rule 3.
    /// A sequence view with a non-null element is a supertype view of the
    /// same container, so rule 3 does apply to it (#4420); that row moved to
    /// the fixture above.
    /// @param body The probe body.
    @Theory
    @InlineData("    let o object = Ob.ArrWithNil()\n    Console.WriteLine(o)")
    func Section3_AnUncomparablePair_Is_Declined_Not_Rejected(body string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, Describe(compiled))
    }

    /// Rule 5 for a magic collection, and the fact the rule-3 fixture above
    /// rests on: an element read through a `[]string!` receiver is
    /// `string!`, so it is checked at its own coercion point rather than
    /// being silently non-null.
    @Fact
    func Section3_AnElementReadThroughAPlatformCollection_Is_Itself_Platform() {
        using let world = World()
        let element = world.GlobalProbeType("let probe = Ob.ArrWithNil()[0]", NullabilityMode.PlatformTypes)
        Assert.IsType[PlatformTypeSymbol](element)
        Assert.Equal("string!", element.Name)
    }

    /// ADR-0186 §4: the check actually fires, at runtime, with an attributable
    /// message — and it fires at the <b>upcast</b>, which is Copilot finding
    /// HIGH-1's shape (`object o = obliviousCall()`).
    ///
    /// Asserting the throw rather than the emitted opcodes is deliberate.
    /// §4's justification is not "some IL exists" but "the failure is
    /// attributable at the boundary where the CLR offers nothing", and only
    /// running it shows that the check is reached, the exception type is the
    /// one existing `catch` clauses expect, and the message names the
    /// expression.
    @Theory
    @InlineData("    let s string = Ob.Nil()\n    Console.WriteLine(s)", "a declared non-null local")
    @InlineData("    let s object = Ob.Nil()\n    Console.WriteLine(s)", "an upcast to object (HIGH-1)")
    @InlineData("    takesString(Ob.Nil())", "an argument to a non-null parameter")
    @InlineData("    Console.WriteLine(returnsString())", "a return from a non-null function")
    @InlineData("    Console.WriteLine(Ob.Nil().Length)", "an instance member receiver")
    @InlineData("    Console.WriteLine(Ob.NilNumbers()[0])", "an indexer receiver")
    @InlineData("    Console.WriteLine(Ob.Nil()!!)", "an explicit '!!'")
    @InlineData("    Console.WriteLine(Ob.NilNumbers().Count())", "an extension method's receiver (case study 6)")
    @InlineData(
        "    let f (() -> string) = Ob.Nil().Trim\n    Console.WriteLine(f())",
        "a method-group capture (the ldftn worst case)"
    )
    @InlineData("    Console.WriteLine(Ob.Nil().Trim().Length)", "a chained receiver with no syntax (failure mode 3)")
    @InlineData(`    for v in Ob.NilNumbers() {
        Console.WriteLine(v)
    }`, "a foreach source")
    @InlineData("    Ob.NilNest().Prop = \"x\"", "a property-write receiver")
    @InlineData("    let alias List[string?] = Ob.NilStrings()", "a container whose OUTER type is platform-wrapped")
    @InlineData("    throw Ob.NilException()", "a 'throw' operand")
    @InlineData(`    lock Ob.NilLockTarget() {
        Console.WriteLine(1)
    }`, "a 'lock' subject")
    func Section4_TheCheck_Throws_An_Attributable_NullReferenceException(body string, site string) {
        using let world = World()
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers)
            }
        )
        // The improvement over an unattributed NRE is the message — §4's whole
        // argument for a call-site check. An empty or default message means
        // the parameterless constructor was emitted, i.e. the site fell back
        // to the plain `!!` lowering and lost its attribution.
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
        // The site is named too — a bare "was nil" would locate nothing, and
        // §4's whole claim over the CLR's own check is attribution.
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal)
        Assert.False(string.IsNullOrWhiteSpace(thrown.Message), site)
    }

    /// The negative control for the fixture above, and §4's "and nowhere else"
    /// clause: a platform value flowing into a `T?` or `T!`
    /// destination crosses no boundary, so nothing throws.
    ///
    /// Also covers the two §4 bullets that are easy to get wrong in the unsafe
    /// direction — a <b>type pattern</b> against a nil scrutinee <em>does not
    /// match and does not throw</em> (a pattern test is a question about the
    /// value, not a use of it as non-null), and a guarded `?.` access.
    @Theory
    @InlineData("    Ob.TakesPlatform(nil)", "took nil")
    @InlineData("    let s string? = Ob.Nil()\n    Console.WriteLine(s == nil)", "True")
    @InlineData("    let s = Ob.Nil()\n    Console.WriteLine(s == nil)", "True")
    @InlineData("    takesNilable(Ob.Nil())", "nilable")
    @InlineData("    Console.WriteLine(Ob.Nil()?.Length)", "")
    @InlineData("    Console.WriteLine(Ob.Nil() ?? \"fallback\")", "fallback")
    @InlineData(
        "    let r = switch Ob.Nil() { case v is string: \"matched\" default: \"unmatched\" }\n    Console.WriteLine(r)",
        "unmatched"
    )
    @InlineData(`    if let v = Ob.Nil() {
        Console.WriteLine("bound")
    } else {
        Console.WriteLine("nil")
    }`, "nil")
    func Section4_NoCheck_Is_Inserted_Where_No_NonNull_Destination_Exists(body string, expected string) {
        using let world = World()
        let output = world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers)
        Assert.Equal(expected, output.Trim())
    }

    /// ADR-0186 §4's escape hatch: `--platform-nil-checks=off` suppresses
    /// insertion.
    ///
    /// The ADR insists this be described honestly: it is <b>strictly weaker
    /// than either the old or the new model</b>. Today the same site is a
    /// compile <em>error</em>; with checks off it is neither an error nor a
    /// check, and the nil simply travels until something else notices — which
    /// is exactly what this test observes, by watching the failure move from
    /// gsc's attributable message to an unattributed CLR NRE deeper in.
    @Fact
    func Section4_ThePlatformNilChecksSwitch_Suppresses_Insertion() {
        const body = "    let s string = Ob.Nil()\n    Console.WriteLine(s.Length)"
        using let world = World()
        let withChecks = Assert.Throws[NullReferenceException](
            func () object? {
                return world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers)
            }
        )
        Assert.Contains("nullability-oblivious", withChecks.Message, StringComparison.Ordinal)
        let withoutChecks = Assert.Throws[NullReferenceException](
            func () object? {
                return world.Run(
                    body,
                    NullabilityMode.PlatformTypes,
                    extraDeclarations: NilHelpers,
                    platformNilChecks: false
                )
            }
        )
        Assert.DoesNotContain("nullability-oblivious", withoutChecks.Message, StringComparison.Ordinal)
    }

    /// The switch suppresses the <b>check</b>, and nothing else.
    ///
    /// The two were coupled at first, and the coupling was invisible to the
    /// fixture above because a declared-slot store is the one shape that does
    /// not need the unwrap. The same helper that inserts §4's check is also
    /// §5's mechanism — replacing a platform receiver with one typed at the
    /// bare underlying is what makes member lookup run against `T` — so
    /// returning the still-wrapped expression turned <em>working</em> indexer
    /// and `for … in` code into GS0116 "not indexable" compile errors
    /// under a switch whose entire purpose is to drop a runtime check for
    /// measurement. A measurement switch that changes what compiles measures
    /// nothing.
    /// @param body The probe body.
    @Theory
    @InlineData("    Console.WriteLine(Ob.Numbers()[0])")
    @InlineData(`    for v in Ob.Numbers() {
        Console.WriteLine(v)
    }`)
    @InlineData("    Console.WriteLine(Ob.Value().Length)")
    @InlineData("    Ob.Nest2().Prop = \"x\"")
    func Section4_ThePlatformNilChecksSwitch_Suppresses_Only_The_Check(body string) {
        using let world = World()
        // Compiles either way: the switch must not move the binder.
        Assert.True(world.Compile(body, NullabilityMode.PlatformTypes, platformNilChecks: true).Success, "checks on")
        Assert.True(world.Compile(body, NullabilityMode.PlatformTypes, platformNilChecks: false).Success, "checks off")
    }

    /// ADR-0186 §3's overload tie-break: a `T!` argument is applicable to
    /// both a `T` and a `T?` parameter, and `T` wins.
    ///
    /// Worth its own fixture because nothing else can catch it. Every
    /// conversion kind the ranker compares is derived from CLR types, and
    /// `string`, `string?` and `string!` are one CLR type, so
    /// the two candidates tie and the rule has to be stated explicitly in
    /// `ComparePlatformArgumentTargets`. Reverting that method leaves
    /// every other test in this PR green.
    ///
    /// ADR open question 10 records this as the one place the design
    /// reproduces failure mode 5's <em>shape</em> — the same line selecting a
    /// different method by typing — and accepts it deliberately, because the
    /// `T` overload is the one a non-nilable argument would have picked
    /// and CLR metadata cannot express such a pair. Accepted deliberately is
    /// exactly the kind of decision that needs a witness.
    @Fact
    func Section3_APlatformArgument_Prefers_The_NonNull_Overload() {
        const overloads = `func G(s string) string {
    return "non-null"
}

func G(s string?) string {
    return "nilable"
}`
        using let world = World()
        // The control: a G#-declared `string?` argument picks the `T?`
        // overload, so the pair really is discriminating.
        Assert.Equal(
            "nilable",
            world.Run(
                "    let n string? = \"x\"\n    Console.WriteLine(G(n))",
                NullabilityMode.PlatformTypes,
                extraDeclarations: overloads
            )
                .Trim()
        )
        // The rule: a `string!` argument picks the non-null overload.
        Assert.Equal(
            "non-null",
            world.Run(
                "    Console.WriteLine(G(Ob.Value()))",
                NullabilityMode.PlatformTypes,
                extraDeclarations: overloads
            )
                .Trim()
        )
    }

    /// ADR-0186 §6: every null-handling construct accepts a `T!`, and the
    /// diagnostic that used to reject it does not fire.
    ///
    /// Each row names the diagnostic it pins. These are all "gains `T!`
    /// on the admits-nil side of its test" rows in §7's table, and each one
    /// was measurably firing on step 1's baseline — the fixture is a
    /// difference, not a restatement.
    /// @param body The probe body.
    /// @param diagnostic The diagnostic that must not fire.
    @Theory
    @InlineData(`    if let v = Ob.Value() {
        Console.WriteLine(v)
    }`, "GS0296")
    @InlineData("    guard let v = Ob.Value() else { return }\n    Console.WriteLine(v)", "GS0296")
    @InlineData(`    var s = Ob.Value()
    s ??= "x"
    Console.WriteLine(s)`, "GS0298")
    @InlineData("    Console.WriteLine(Ob.Value() ?? \"x\")", "GS0298")
    @InlineData("    Console.WriteLine(Ob.Value()?.Length)", "GS0300")
    @InlineData("    Console.WriteLine(Ob.Table()?[\"k\"])", "GS0300")
    @InlineData("    Console.WriteLine(Ob.Value() == nil)", "GS0129")
    @InlineData("    Console.WriteLine(Ob.Table() == nil)", "GS0523")
    @InlineData("    Console.WriteLine(Ob.Value()!!)", "GS0536")
    func Section6_EveryNullHandlingConstruct_Accepts_APlatformOperand(body string, diagnostic string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.DoesNotContain(compiled.Diagnostics, (d DiagnosticLine) -> d.Id == diagnostic)
    }

    /// The negative half of §6: the diagnostics above are <b>narrowed, not
    /// deleted</b>. A genuinely non-null `T` operand still reports each
    /// one, so the fixture above is a statement about `T!` and not a
    /// blanket weakening of G#'s own null model — which ADR-0186 lists under
    /// "Explicitly out of scope".
    /// @param body The probe body.
    /// @param diagnostic The diagnostic that must still fire.
    @Theory
    @InlineData(`    let plain string = "v"
    if let v = plain {
        Console.WriteLine(v)
    }`, "GS0296")
    @InlineData(`    var plain string = "v"
    plain ??= "x"
    Console.WriteLine(plain)`, "GS0298")
    @InlineData("    let plain = Dictionary[string, int32]()\n    Console.WriteLine(plain?[\"k\"])", "GS0300")
    @InlineData("    let plain string = \"v\"\n    Console.WriteLine(plain!!)", "GS0536")
    func Section6_TheSameDiagnostics_Still_Fire_For_APlainNonNullOperand(body string, diagnostic string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.Contains(compiled.Diagnostics, (d DiagnosticLine) -> d.Id == diagnostic)
    }

    /// ADR-0069 narrowing applies to a `T!`, and this is what makes the
    /// platform model ergonomic rather than merely permissive: inside
    /// `if x != nil { … }` the value has type `T`, so the coercion
    /// that follows is not a `T! → T` coercion at all and §4 inserts
    /// nothing.
    ///
    /// <b>Asserted by counting the synthesized checks in the bound tree</b>,
    /// because nothing weaker discriminates. An earlier version of this test
    /// used a nil-valued source, which made the guarded branch dead and let
    /// it pass whether or not narrowing happened; and even in a reachable
    /// branch a plain "it compiles" assertion proves nothing, since
    /// `T! → T` is an implicit conversion either way — it just carries
    /// a check. The check count is the only observable that moves.
    ///
    /// This was a real gap, not a hypothetical one:
    /// `SmartCastStability.TryClassifyNilGuardLeaf` tested
    /// `is not NullableTypeSymbol` and so rejected every platform target
    /// outright, which made §6's narrowing claim false for `T!`.
    @Fact
    func Section6_Narrowing_Applies_And_Removes_The_Coercion() {
        const guarded = `    let value = Ob.Value()
    if value != nil {
        let narrowed string = value
        Console.WriteLine(narrowed)
    }`
        const unguarded = `    let value = Ob.Value()
    let narrowed string = value
    Console.WriteLine(narrowed)`
        using let world = World()
        // The control: with no guard, the store is a `T! -> T` coercion and
        // §4 inserts exactly one check.
        Assert.Equal(1, world.CountPlatformChecks(unguarded))
        // The claim: after the guard the read is already `T`, so there is no
        // coercion left to check.
        Assert.Equal(0, world.CountPlatformChecks(guarded))
        // …and it still runs, on the branch that is actually reachable.
        Assert.Equal("V", world.Run(guarded, NullabilityMode.PlatformTypes).Trim())
    }

    /// ADR-0186 §3's unification rule in a ternary, both arm orders.
    ///
    /// The same `T!?` defect as `?.` and `??` reached here
    /// too, and worse: the common-type computation picks whichever arm it
    /// sees first, so `platform ? : nilable` and
    /// `nilable ? : platform` produced <em>different</em> result types.
    /// A type that depends on the order the author happened to write the arms
    /// in is not a type rule at all.
    ///
    /// Fixed by the same normalisation as the others (`T!?` collapses to
    /// `T?` at `NullableTypeSymbol.Get`), which is the argument for
    /// having centralised it: this site was never touched directly.
    /// @param globals A probe declaring `probe`.
    /// @param expected The expected unified type.
    @Theory
    @InlineData("let n string? = \"n\"\nlet probe = if true { Ob.Value() } else { n }", "string?")
    @InlineData("let n string? = \"n\"\nlet probe = if true { n } else { Ob.Value() }", "string?")
    @InlineData("let probe = if true { Ob.Value() } else { \"x\" }", "string!")
    func Section3_TernaryUnification_Is_ArmOrderIndependent(globals string, expected string) {
        using let world = World()
        let unified = world.GlobalProbeType(globals, NullabilityMode.PlatformTypes)
        Assert.Equal(expected, unified.Name)
    }

    /// ADR-0186 §8, the half step 3 cannot do without: a platform type
    /// <b>reaches the emitter from ordinary source</b>, and it must be
    /// encoded rather than refused.
    ///
    /// Step 1 made `NullableFlagsBuilder.Append` throw
    /// `NotSupportedException` for a `T!`, on the reasoning that
    /// the path was unreachable with the flag off and that the alternative
    /// then available — the fall-through writing byte `1` — would
    /// launder an unknown into a guarantee in metadata. Both halves were
    /// right; only the first stopped being true. Every row below is a
    /// <em>synthesized member signature</em> whose type came from type
    /// inference over an oblivious call, with no `@Oblivious` anywhere
    /// and nothing from §9:
    ///
    /// - a global `let` with no type clause — a static field of type `string!`;
    /// - a local captured by a lambda — a display-class field of type `string!`;
    /// - a local captured across a `defer`, which is the shape `DeferStatementTests` hit.
    ///
    /// This is the fixture that says the refusal was a step-3 blocker and not
    /// a test artifact. Each row turns red on the parent commit with the
    /// emitter's `NotSupportedException`, and the byte it now writes is
    /// pinned — at `0`, never `1` — by
    /// `Adr0186PlatformTypeSymbolTests.Emit_Encodes_A_Platform_Type_As_The_Oblivious_Byte`.
    /// @param body The probe body.
    /// @param extra Extra top-level declarations.
    /// @param expected The expected program output.
    @Theory
    @InlineData(`    let s = Ob.Value()
    let f = func() string { return s }
    Console.WriteLine(f())`, "", "V")
    @InlineData("    let s = Ob.Value()\n    defer Console.WriteLine(s)", "", "V")
    func Section8_APlatformTypedSynthesizedSignature_Emits_Rather_Than_Refusing(
        body string,
        extra string,
        expected string
    ) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes, extra)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes, extra).Trim())
    }

    /// The third synthesized-signature shape: a <b>global</b> `let` with
    /// no type clause, which becomes a static field typed `string!`.
    ///
    /// Asserted on <em>emit success</em> only, not on program output, and the
    /// reason is a property of the fixture rather than of this change: this
    /// world's probe source declares `func Main()` as the entry point,
    /// and a top-level global's initializer does not run ahead of it here —
    /// measured with a platform-free `let probe = "V"`, which prints
    /// nothing either. Asserting output would be asserting that fixture
    /// quirk. What this row is for is the emitter, and the emitter is
    /// exactly what threw: on the parent commit this reports
    /// `NotSupportedException: Cannot emit nullable metadata for the
    /// platform type 'string!'`.
    @Fact
    func Section8_AGlobalInferredLet_Emits_ItsPlatformTypedField() {
        using let world = World()
        let compiled = world.Compile(
            "    Console.WriteLine(probe)",
            NullabilityMode.PlatformTypes,
            "let probe = Ob.Value()"
        )
        Assert.True(compiled.Success, Describe(compiled))
    }

    /// Issue #4323 — ADR-0186 §5a for the indexer <b>write</b> path.
    ///
    /// Failure mode 1 of the ADR's catalogue, one access kind over: reading
    /// `l[0]` through a platform receiver bound correctly because
    /// `BindIndexAgainstTarget` unwraps, while writing `l[0] = "q"`
    /// reported GS0116 <em>"type 'List[string]!' is not indexable"</em>,
    /// because the assignment path had no equivalent. A receiver's
    /// platform-ness deciding whether a member exists is precisely what §5a
    /// forbids, and "the read path and the write path drifted" is how the
    /// predicate system this ADR replaces started.
    /// @param body The probe body.
    /// @param expected The expected program output.
    @Theory
    @InlineData(`    let l = Ob.WrapList("a")
    l[0] = "q"
    Console.WriteLine(l[0])`, "q")
    @InlineData(`    let t = Ob.Table()
    t["k"] = 9
    Console.WriteLine(t["k"])`, "9")
    @InlineData(`    let a = Ob.ArrWithNil()
    a[0] = "q"
    Console.WriteLine(a[0])`, "q")
    func Section5_TheIndexerWritePath_Unwraps_Like_TheReadPath(body string, expected string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.DoesNotContain(compiled.Diagnostics, (d DiagnosticLine) -> d.Id == "GS0116")
        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim())
    }

    /// Issue #4324 — ADR-0186 §6 for the concatenation operator.
    ///
    /// `string! + "x"` reported GS0129 <em>"operator '+' is not defined
    /// for types 'string!' and 'string'"</em> in both operand orders, because
    /// `BoundBinaryOperator.IsStringOrNullableString` tested only
    /// `string` and `string?` while the `supportedOperators`
    /// table matches operand types exactly and cannot see through a wrapper.
    /// §6's claim is that `T!` participates in every existing construct;
    /// an oblivious string being <em>less</em> capable than either a
    /// `string` or a `string?` is that claim failing.
    ///
    /// The `string? + "x"` control is what makes this a difference
    /// rather than a restatement: it has compiled since issue #1927, and the
    /// platform row is being brought into line with it, not given a new rule.
    /// @param body The probe body.
    /// @param expected The expected program output.
    @Theory
    @InlineData("    Console.WriteLine(Ob.Value() + \"x\")", "Vx")
    @InlineData("    Console.WriteLine(\"x\" + Ob.Value())", "xV")
    @InlineData("    Console.WriteLine(Ob.Value() + Ob.Suffix())", "Vx")
    @InlineData("    Console.WriteLine(\"[\" + Ob.Nil() + \"]\")", "[]")
    @InlineData("    let n string? = nil\n    Console.WriteLine(\"[\" + n + \"]\")", "[]")
    func Section6_StringConcatenation_Accepts_APlatformOperand(body string, expected string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim())
    }

    /// Issue #4324, the half the first fix missed: a <b>char</b> operand.
    ///
    /// `string + char` is not in the operator table at all — the binder
    /// adapts the char to a string first (issue #3463), and that adaptation
    /// recognised its string side only as `string` or `string?`. So
    /// `string! + "x"` bound while `string! + 'c'` and
    /// `s += 'c'` on a `string!` local reported GS0129 — reached in
    /// the nightly self-migration corpus by `Gsharp.NET.Sdk`, which
    /// targets netstandard2.0 and so sees every BCL string as `string!`.
    /// @param body The probe body.
    /// @param expected The expected program output.
    @Theory
    @InlineData("    Console.WriteLine(Ob.Value() + 'c')", "Vc")
    @InlineData("    Console.WriteLine('c' + Ob.Value())", "cV")
    @InlineData(`    var s = Ob.Value()
    s += 'c'
    Console.WriteLine(s)`, "Vc")
    @InlineData(`    var s = Ob.Value()
    s += "y"
    Console.WriteLine(s)`, "Vy")
    @InlineData("    Console.WriteLine(\"[\" + Ob.Nil() + ']')", "[]")
    func Section6_StringConcatenation_WithAChar_Accepts_APlatformOperand(body string, expected string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim())
    }

    /// Issue #4361: an <b>open type-parameter slot</b> of an unannotated
    /// declaration takes its nullability from the type argument (ADR-0186
    /// §2), so a generic call's result converts exactly as the same call to an
    /// annotated declaration would — only the concrete container position is
    /// platform-typed.
    ///
    /// Each row is a shape that took `main`'s nightly self-migration
    /// corpus red: the reader stamped the declaration's ABSENT nullability
    /// byte onto the substituted argument, inventing a nested `T!` that
    /// §3 rule 3 then correctly refused to convert (`[]string!` to
    /// `[]?string`, `IEnumerable[string!]!` to
    /// `IEnumerable[string]?`, `Arbitrary[Type!]` to
    /// `Arbitrary[Type]`).
    /// @param body The probe body.
    /// @param expected The expected program output.
    @Theory
    @InlineData("    var a []?string = Ob.EmptyArr[string]()\n    Console.WriteLine(a!!.Length)", "0")
    @InlineData("    var a []string = Ob.EmptyArr[string]()\n    Console.WriteLine(a.Length)", "0")
    @InlineData("    var e IEnumerable[string]? = Ob.EmptySeq[string]()\n    Console.WriteLine(e!!.Count())", "0")
    @InlineData(`    let x IEnumerable[string]? = nil
    let p = x ?? Ob.EmptySeq[string]()
    Console.WriteLine(p.Count())`, "0")
    @InlineData(`    let x IEnumerable[string]? = nil
    let p = (x ?? Ob.EmptySeq[string]())!!
    Console.WriteLine(p.Count())`, "0")
    @InlineData(`    let xs = []string{"a"}
    let r []string = Ob.Same(xs)
    Console.WriteLine(r[0])`, "a")
    @InlineData("    let h Holder[string] = Ob.Hold(\"x\")!!\n    Console.WriteLine(h.Value)", "x")
    func Section2_AnOpenSlot_OfAnUnannotatedGeneric_Converts_Like_ItsArgument(body string, expected string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, Describe(compiled))
        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim())
    }

    /// Issue #4361, at the reader: an open slot of an unannotated generic reads
    /// the argument's nullability, the concrete container stays oblivious, and
    /// a CONCRETE inner position is untouched. Observed through the display,
    /// which is also issue #4361's diagnostic fix: an imported platform array
    /// is spelled `[]!T` (ADR-0132's positional rule) and a nested
    /// platform argument shows its `!`.
    ///
    /// Uses the csc-emitted library rather than an in-assembly
    /// `#nullable disable` fixture on purpose: the latter stops being
    /// oblivious when `test/Core.Tests` is itself self-migrated to G#,
    /// and the migrated suite's test parity would then fail it.
    /// @param globals The probe.
    /// @param expected The expected display of the probe's type.
    @Theory
    @InlineData("let probe = Ob.EmptyArr[string]()", "[]!string")
    @InlineData("let probe = Ob.EmptySeq[string]()", "System.Collections.Generic.IEnumerable[string]!")
    @InlineData("let probe = Ob.Hold(\"x\")", "Adr0186.Step2.Library.Holder[string]!")
    @InlineData("let probe = Ob.Strings()", "System.Collections.Generic.List[string!]!")
    func Section2_AnOpenSlot_OfAnUnannotatedGeneric_Reads_ItsArgument(globals string, expected string) {
        using let world = World()
        Assert.IsType[PlatformTypeSymbol](world.GlobalProbeType(globals, NullabilityMode.PlatformTypes))
        Assert.Equal(expected, world.LastProbeDisplay)
    }

    /// ADR-0186 §3 rule 2 at an <b>indexer parameter</b>: a
    /// `C[T!]` argument stays applicable to a `C[T?]` parameter.
    ///
    /// Rule 2 is the single conversion a constructed type permits, and
    /// symbolic indexer applicability has to honour it.
    /// `TryClassifyConstructedGenericConversion`'s invariant arm uses
    /// `SameTypeSymbol` as its <em>complete</em> verdict and returns
    /// before the general classifier runs, so once that helper correctly
    /// stopped calling `string!` and `string?` the same type, a
    /// non-identical pair would have been read as final incompatibility —
    /// Copilot review finding on the flip PR. The arm now also asks
    /// `Conversion.IsPlatformArgumentWidening`, which is the same
    /// implementation the classifier uses rather than a second copy of the
    /// rule.
    ///
    /// <b>Asserted at the relation, not end to end, and that is a
    /// limitation worth stating.</b> The symbolic-indexer path this guards is
    /// only entered when some argument has no `ClrType` — a
    /// same-compilation user type — and a `C[T!]` argument always has
    /// one, so an end-to-end probe goes through CLR resolution instead and
    /// passes with or without the fix (measured: it does not discriminate).
    /// The production change is therefore <em>defensive</em>: correct
    /// wherever the relation is asked, but with no constructed repro. What
    /// this test pins is the rule itself, which does discriminate — removing
    /// the `Widening` arm from `RelatePlatformArguments` reddens
    /// it.
    @Fact
    func Section3_RuleTwoWidening_Is_The_OnlyPermitted_ArgumentRelation() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        let nilable = NullableTypeSymbol.Get(TypeSymbol.String)
        // Rule 2: `T! -> T?` is the one permitted widening.
        Assert.True(GsConversion.IsPlatformArgumentWidening(platform, nilable))
        // Rule 3's three illegal directions, and the identity case, are all
        // NOT widenings — so the applicability arm that consults this cannot
        // reopen the aliasing hole it was added beside.
        Assert.False(GsConversion.IsPlatformArgumentWidening(platform, TypeSymbol.String))
        Assert.False(GsConversion.IsPlatformArgumentWidening(TypeSymbol.String, platform))
        Assert.False(GsConversion.IsPlatformArgumentWidening(nilable, platform))
        Assert.False(GsConversion.IsPlatformArgumentWidening(platform, platform))
        // A platform-free pair is not this relation's business at all.
        Assert.False(GsConversion.IsPlatformArgumentWidening(TypeSymbol.String, nilable))
        // …and its companion, which is what keeps rule 3 closed at an
        // applicability check whose same-type helper deliberately looks
        // THROUGH the platform wrapper. `SameTypeSymbol` has to unwrap —
        // member hiding needs `T!` and `T` to be one signature, and making
        // them distinct there collapsed `Issue2525`'s interface diamond into
        // GS0266 "ambiguous between multiple overloads". So the two
        // questions are asked separately rather than folded into one helper.
        Assert.True(GsConversion.IsPlatformArgumentIllegal(platform, TypeSymbol.String))
        Assert.True(GsConversion.IsPlatformArgumentIllegal(TypeSymbol.String, platform))
        Assert.True(GsConversion.IsPlatformArgumentIllegal(nilable, platform))
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platform, nilable))
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platform, platform))
        Assert.False(GsConversion.IsPlatformArgumentIllegal(TypeSymbol.String, nilable))
        // An UNRELATED pair is neither: rule 3 speaks only about two
        // positions that are the same underlying type differing in reference
        // nullability, and `Illegal` means "no conversion exists" rather than
        // "this arm cannot decide". Both directions, because the guard
        // existed on one arm and not the other — a Copilot review finding on
        // this PR, in each direction in turn.
        let platformObject = PlatformTypeSymbol.Get(TypeSymbol.Object)
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platformObject, TypeSymbol.String))
        Assert.False(GsConversion.IsPlatformArgumentIllegal(platformObject, nilable))
        Assert.False(GsConversion.IsPlatformArgumentIllegal(TypeSymbol.String, platformObject))
        Assert.False(GsConversion.IsPlatformArgumentWidening(platformObject, nilable))
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
        let platformSlice = SliceTypeSymbol.Get(platform)
        Assert.True(GsConversion.IsPlatformArgumentIllegal(platformSlice, TypeSymbol.Object))
        Assert.False(GsConversion.TryRelatePlatformContainer(platformSlice, TypeSymbol.Object, out _))
    }

    /// The symbolic-indexer counterpart of
    /// `TheContainerRule_Does_Not_Decide_OuterNullability`: a
    /// <b>nilable</b> container must not be accepted — still less
    /// <em>preferred</em> — where a non-null one is required.
    ///
    /// `TryClassifyPlatformTypeArgumentMismatch` declines
    /// `C[T!]? -> C[T?]` on purpose, so that the ordinary
    /// outer-nullability rule can reject the nilable container. But
    /// "declined" and "this pair is unrelated" reach
    /// `ClassifySymbolicIndexerConversion` as the same `false`, and
    /// its same-type fast path strips a top-level reference `?` from
    /// either side — so the pair came back <em>identical</em>, the best match
    /// a candidate can be. Copilot review finding on the flip PR.
    ///
    /// <b>The competitor is what makes it observable.</b> On its own the
    /// over-accepted candidate is still caught, one step later, by the
    /// argument conversion — GS0156 <em>"Cannot convert type
    /// 'List[string]?' to 'List[string?]'"</em>. With a legal
    /// `this[object?]` present, the mis-ranked candidate wins the ranking
    /// outright and takes the whole access down with it, where rejecting it
    /// leaves `object?` to bind.
    ///
    /// <b>Measured as NOT platform-specific</b>, which is why the fix is the
    /// fast path rather than the platform arm: the third case runs the same
    /// program under `--nullability=enabled`, where no platform type
    /// exists anywhere, and it mis-selected identically before the fix. The
    /// fast path has always erased outer reference nullability; ADR-0186 is
    /// only what made someone look.
    @Fact
    func Section3_ANilableContainer_Is_Not_Identical_To_ANonNullOne() {
        using let world = World()
        // `AsNilable` is how the probe gets a genuine nilable OVER a platform
        // container — an inferred `let` cannot, because `T!` already admits
        // nil and a `nil` branch merges into it without adding a `?`.
        const decls = `func AsNilable[T](x T) T? {
    return x
}`
        const alone = "    let k = AsNilable(Ob.Strings())\n    Console.WriteLine(NilableKeys()[k])"
        let rejected = world.Compile(alone, NullabilityMode.PlatformTypes, decls)
        Assert.False(rejected.Success, Describe(rejected))
        // The witness: with a legal competitor, the nilable container must
        // lose rather than win-and-fail. Mutating out the outer-nullability
        // guard reddens this with GS0156.
        const competing = "    let k = AsNilable(Ob.Strings())\n    Console.WriteLine(NilableOrObjectKeys()[k])"
        Assert.Equal("object", world.Run(competing, NullabilityMode.PlatformTypes, decls).Trim())
        // …and the same program with no platform type anywhere, which is what
        // establishes the defect as pre-existing rather than introduced by
        // the flip.
        Assert.Equal("object", world.Run(competing, NullabilityMode.Enabled, decls).Trim())
    }

    /// ADR-0186 §3 at a symbolic indexer parameter, <b>end to end</b> — and
    /// the fast path it has to be asked before.
    ///
    /// `ClassifySymbolicIndexerConversion` opened with
    /// `SameTypeSymbol`, which looks through a platform wrapper by design
    /// (member hiding needs `T!` and `T` to be one CLR signature —
    /// making them distinct there collapsed `Issue2525`'s interface
    /// diamond into GS0266). So it answered <em>identity</em> for
    /// `List[string!]` against `List[string]` and returned before
    /// the rule-3 guard below it ever ran: the aliasing conversion the guard
    /// exists to reject stayed applicable, and rule 2's
    /// `List[string!] -> List[string?]` — a permitted
    /// <em>non-identity</em> widening — was mis-ranked as identity, which the
    /// candidate ranker prefers. Copilot review finding on the flip PR.
    ///
    /// The question is now asked through
    /// `Conversion.TryRelatePlatformContainer`, the same guarded entry
    /// the general classifier on the last line of that method already uses —
    /// so this is a hoist above the fast path, not a new rule — and
    /// deliberately not through the per-<em>argument</em> predicates one
    /// method down, which assume a container that has already been matched
    /// and would answer `Illegal` for an ordinary upcast such as
    /// `[]string! -> object`.
    ///
    /// <b>Why this fixture and not a simpler one.</b> The symbolic path is
    /// entered only when an argument has no `ClrType` or the receiver
    /// type has a set-only indexer, and a `List[string!]` argument always
    /// has a `ClrType` — an earlier attempt at this test went through
    /// reflection against the erased CLR shape instead and passed with the fix
    /// mutated out. Hence `ExactKeys`/`NilableKeys`' set-only
    /// `int` member, which also makes an empty applicable set final
    /// rather than a fallback to that erased retry. Mutation witness:
    /// removing the hoist compiles the second probe, which is the aliasing
    /// hole.
    @Fact
    func Section3_SymbolicIndexerApplicability_Asks_TheRule_Before_TheSameTypeFastPath() {
        using let world = World()
        // Rule 2: `List[string!]! -> List[string?]` is the one container
        // conversion the ADR permits, and it must stay applicable — a guard
        // that rejected everything platform-shaped would redden here.
        const permitted = "    let keys = Ob.Strings()\n    Console.WriteLine(NilableKeys()[keys])"
        Assert.Equal("nilable", world.Run(permitted, NullabilityMode.PlatformTypes).Trim())
        // Rule 3: `List[string!]! -> List[string]` hands a container that
        // demonstrably holds a nil (`Strings()`' second element) to a
        // parameter annotated never to. No check can be inserted — the nil is
        // inside the container, not the reference being converted — so the
        // only sound answer is that the indexer is not applicable.
        const illegal = "    let keys = Ob.Strings()\n    Console.WriteLine(ExactKeys()[keys])"
        let rejected = world.Compile(illegal, NullabilityMode.PlatformTypes)
        Assert.False(rejected.Success, "rule 3 must reject C[T!] -> C[T]: " + Describe(rejected))
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
        const competing = "    let keys = Ob.Strings()\n    Console.WriteLine(OverloadedKeys()[keys])"
        Assert.Equal("object", world.Run(competing, NullabilityMode.PlatformTypes).Trim())
    }

    /// ADR-0186 §4: the receiver check elided inside an expression-tree
    /// lambda is <b>redundant, not missing</b> — the tree still throws.
    ///
    /// Review objected that `Expression.Call` on a non-virtual method
    /// may emit `call`, which does not reject a null `this`, so a
    /// member that never touches its receiver could complete on a nil and
    /// lose the failure entirely rather than merely its message. That is
    /// exactly the kind of claim ADR-0186 says is worth only as much as the
    /// enumeration behind it — its own §4 receiver exemption was falsified
    /// that way — so it is measured here rather than argued.
    ///
    /// Measured directly against `System.Linq.Expressions` (sealed
    /// class, field and property receivers, auto-property and a getter that
    /// provably never reads `this`): <b>all four throw
    /// <c>NullReferenceException</c></b>. The expression compiler emits the
    /// dereferencing form for instance member access regardless of
    /// virtuality, exactly as `csc` does. This test keeps that a live
    /// assertion through G#'s own pipeline: what is lost by the elision is
    /// G#'s message (#4352), never the failure.
    @Fact
    func Section4_AnElidedReceiverCheck_Still_Throws_When_TheTreeRuns() {
        using let world = World()
        let output = world.Run(`    let n = Ob.NilNest()
    let e Expression[Func[string?]] = () -> n.Prop
    let c = e.Compile()
    try {
        Console.WriteLine(c())
    } catch (NullReferenceException) {
        Console.WriteLine("threw")
    }`, NullabilityMode.PlatformTypes)
        Assert.Equal("threw", output.Trim())
    }

    /// ADR-0186 §6: reference <b>equality</b> with a platform operand takes
    /// no §4 check, because comparing two references is not a use of either
    /// as non-null.
    ///
    /// §4's sites are a store, an argument, a return, a
    /// `throw`/`lock`/`for … in` subject and a receiver.
    /// `==` is none of them: it never dereferences. §6 already makes
    /// `x == nil` free on a `T!`, and comparing against a non-nil
    /// `string` is the same operation with a different right-hand side.
    ///
    /// Without the operator arm, the `supportedOperators` lookup missed
    /// (it is an exact type match and cannot see through a wrapper),
    /// resolution fell through to the CLR `op_Equality`, and the
    /// platform operand became an <em>argument</em> to a non-null
    /// parameter — so a check was inserted on a comparison. That spurious
    /// check is what made
    /// `Issue2661ExpressionTreeNullablePipelineTests`' `.Where(b ->
    /// b.Conversion.AccountId == id)` report GS0473, since a non-receiver
    /// coercion inside an expression-tree lambda is (correctly) rejected.
    ///
    /// Asserted by <b>counting the synthesized checks</b>, which is the only
    /// observable that moves — the comparison compiles either way.
    /// @param body The probe body.
    @Theory
    @InlineData("    let x = Ob.Value() == \"v\"\n    Console.WriteLine(x)")
    @InlineData("    let x = \"v\" == Ob.Value()\n    Console.WriteLine(x)")
    @InlineData("    let x = Ob.Value() != Ob.Suffix()\n    Console.WriteLine(x)")
    func Section6_ReferenceEquality_With_APlatformOperand_Inserts_NoCheck(body string) {
        using let world = World()
        Assert.Equal(0, world.CountPlatformChecks(body))
        Assert.True(world.Compile(body, NullabilityMode.PlatformTypes).Success)
    }

    /// Issue #4325 — the three remaining §4 positions: delegate invocation,
    /// compound member assignment, and deconstruction.
    ///
    /// None of these was a silent escape — each already failed at runtime for
    /// a nil platform value. What was missing is the <em>attribution</em>,
    /// which is the entire justification §4 gives for preferring a call-site
    /// check over whatever the CLR happens to do: an
    /// `NullReferenceException` naming the expression, the oblivious
    /// origin, and the file:line beats a bare one from inside a lowered
    /// construct.
    ///
    /// Asserted on the <b>message</b>, not on the exception type, because the
    /// type does not move: §4 keeps `NullReferenceException` deliberately
    /// so existing `catch` clauses behave as they do. A test that
    /// asserted only "it throws" would be green on the parent commit.
    /// @param body The probe body.
    /// @param site What the row covers.
    @Theory
    @InlineData("    let f = Ob.NilThunk()\n    Console.WriteLine(f())", "delegate invocation")
    @InlineData("    let f = Ob.NilThunk()\n    Console.WriteLine((f)())", "delegate invocation, parenthesised callee")
    @InlineData("    let n = Ob.NilNested()\n    n.Num += 1", "compound member assignment")
    @InlineData("    let (a, b) = Ob.NilPt()\n    Console.WriteLine(a + b)", "deconstruction, statement form")
    @InlineData(`    for (a, b) in Ob.WrapList(Ob.NilPt()) {
        Console.WriteLine(a + b)
    }`, "deconstruction, loop prelude")
    @InlineData("    let p = Ob.NilNest()\n    Console.WriteLine(p.Prop)", "member read (the covered control)")
    func Section4_TheRemainingPositions_Produce_AnAttributedFailure(body string, site string) {
        using let world = World()
        let compiled = world.Compile(body, NullabilityMode.PlatformTypes)
        Assert.True(compiled.Success, site + ": " + Describe(compiled))
        let failure = Assert.ThrowsAny[Exception](
            func () object? {
                return world.Run(body, NullabilityMode.PlatformTypes)
            }
        )
        let message = Unwrap(failure).Message
        Assert.Contains("nullability-oblivious", message, StringComparison.Ordinal)
    }

    /// The positive controls for the fixture above: the same three shapes on
    /// a <b>non-nil</b> platform value run normally, so the inserted checks
    /// are checks and not unconditional failures.
    /// @param body The probe body.
    /// @param expected The expected program output.
    @Theory
    @InlineData("    let f = Ob.Thunk()\n    Console.WriteLine(f())", "V")
    @InlineData("    let f = Ob.Thunk()\n    Console.WriteLine((f)())", "V")
    @InlineData(`    let n = Ob.Nest2()
    n.Num += 1
    Console.WriteLine(n.Num)`, "1")
    @InlineData("    let (a, b) = Ob.Pair()\n    Console.WriteLine(a + b)", "ab")
    @InlineData("    let (a, b) = Ob.Pt2()\n    Console.WriteLine(a + b)", "ab")
    @InlineData(`    for (a, b) in Ob.WrapList(Ob.Pt2()) {
        Console.WriteLine(a + b)
    }`, "ab")
    func Section4_TheRemainingPositions_Still_Run_When_NotNil(body string, expected string) {
        using let world = World()
        Assert.Equal(expected, world.Run(body, NullabilityMode.PlatformTypes).Trim())
    }

    /// <b>ADR-0186 step 4 — member lookup must not un-report a receiver the
    /// author declared nilable in G# source.</b>
    ///
    /// Issue #4287's shape: a G#-declared `var name string?` field,
    /// dereferenced with no guard. The member-lookup carve-out that step 4 kept
    /// and #4356 deleted (`|| receiver is BoundClrPropertyAccessExpression`
    /// in `CanBindClrInstanceMember`) never applied here — a field read on
    /// a G#-declared class is not a CLR property access — so this must report
    /// exactly as it always has. This is the "one condition, not one block"
    /// trap the ADR names: it is the easiest way to reintroduce #4287's defect
    /// while believing the work is cleanup.
    ///
    /// The <b>read</b> is what is asserted here. Member lookup is what
    /// `CanBindClrInstanceMember` gates; an instance <em>call</em> on a
    /// nilable receiver resolves through a different path, which #4287 gated
    /// separately (`TryReportStatedNullableReceiverCall`, covered by
    /// `Issue4287StatedNullableReceiverCallTests`).
    @Fact
    func Step4_ASourceDeclaredNilableFieldReceiver_Still_Reports() {
        const holder = `class Holder {
    var name string?

    func Len() int32 {
        return this.name.Length
    }
}`
        using let world = World()
        for mode in[]NullabilityMode{NullabilityMode.Enabled, NullabilityMode.PlatformTypes} {
            let compiled = world.Compile("    Console.WriteLine(\"unused\")", mode, extraDeclarations: holder)
            Assert.False(compiled.Success, Describe(compiled))
            Assert.Contains(compiled.Diagnostics, (d DiagnosticLine) -> d.Id == "GS0158")
        }
    }

    /// <b>ADR-0186 step 4 — a source-declared nilable container still selects
    /// the instance member, not the shadowing extension.</b>
    ///
    /// §5a's `ListReverse` witness aimed at a G#-declared
    /// `List[int32]?` rather than at an oblivious receiver.
    /// `import System.Linq` is load-bearing exactly as it is there:
    /// without `Enumerable` in scope there is no competing extension and
    /// the probe witnesses nothing. The failure guarded against is not a
    /// diagnostic changing shape but `xs.Reverse()` quietly becoming
    /// `Enumerable.Reverse` — lazy, copying, result discarded — on a
    /// receiver whose only difference from the baseline is its declared
    /// nullability.
    ///
    /// <b>Since #4287</b> the unguarded `xs.Reverse()` on a
    /// `List[int32]?` reports GS0159 rather than binding either candidate,
    /// so the selection question is asked through the spelling that diagnostic
    /// recommends, `xs?.Reverse()`. That is the shape an author ends up
    /// with, and it must still pick `List<T>.Reverse`. The #4287
    /// gate runs after selection, so it cannot change which member is chosen;
    /// it can only reject the call.
    @Fact
    func Step4_ASourceDeclaredNilableContainer_Selects_TheInstanceMember() {
        const unguarded = "    let xs List[int32]? = List[int32]()\n    xs.Reverse()"
        const nilable = "    let xs List[int32]? = List[int32]()\n    xs?.Reverse()"
        const baseline = "    let xs = List[int32]()\n    xs.Reverse()"
        using let world = World()
        for mode in[]NullabilityMode{NullabilityMode.Enabled, NullabilityMode.PlatformTypes} {
            Assert.Contains(world.Compile(unguarded, mode).Diagnostics, (d DiagnosticLine) -> d.Id == "GS0159")
            Assert.Equal(
                world.SelectedReverseDeclaringType(baseline, mode),
                world.SelectedReverseDeclaringType(nilable, mode)
            )
        }
    }

    /// <b>ADR-0186 step 4 — the <c>StringTrim</c> half of the same gate, on a
    /// source-declared <c>string?</c>.</b>
    ///
    /// The ADR's step-4 sequencing names two witnesses for a source-declared
    /// nilable receiver: `ListReverse`
    /// ((cref:Step4_ASourceDeclaredNilableContainer_Selects_TheInstanceMember))
    /// and this one. The competing member here is
    /// `MemoryExtensions.Trim(this ReadOnlySpan<char>)`, reachable
    /// from a `string` by the implicit span conversion and in scope
    /// through `import System`. The silent failure is `s.Trim()`
    /// retyping to `ReadOnlySpan<char>` on a receiver whose only
    /// difference from the baseline is its declared nullability, so the
    /// assertion is on the bound result TYPE, which is what distinguishes the
    /// two — running the probe would not, since both print the same text.
    ///
    /// As with the `ListReverse` witness, since #4287 the unguarded
    /// `s.Trim()` reports GS0159, and the selection is asserted through
    /// the recommended `s?.Trim()`. Its result is `string?`, whose
    /// CLR type is still `string` and never `ReadOnlySpan<char>`.
    @Fact
    func Step4_ASourceDeclaredNilableString_Trim_Stays_TheStringInstanceMember() {
        const unguarded = "    let s string? = \"  a  \"\n    Console.WriteLine(s.Trim())"
        const nilable = "let s string? = \"  a  \"\nlet probe = s?.Trim()"
        const baseline = "let s = \"  a  \"\nlet probe = s.Trim()"
        using let world = World()
        for mode in[]NullabilityMode{NullabilityMode.Enabled, NullabilityMode.PlatformTypes} {
            Assert.Contains(world.Compile(unguarded, mode).Diagnostics, (d DiagnosticLine) -> d.Id == "GS0159")
            let expected = world.GlobalProbeType(baseline, mode)
            let actual = world.GlobalProbeType(nilable, mode)
            Assert.Equal(typeof(string), expected.ClrType)
            Assert.Equal(expected.ClrType, actual.ClrType)
        }
    }

    /// <b>Issue #4356 — a member chain through an ANNOTATED-nullable imported
    /// member reports, reads and writes alike.</b>
    ///
    /// `CanBindClrInstanceMember` used to carry a second disjunct,
    /// `|| receiver is BoundClrPropertyAccessExpression`, that let a chain
    /// continue through any imported field or property read typed `T?`.
    /// Its purpose (#2459) was oblivious members, which ADR-0186 now imports as
    /// `T!`; what it still admitted was a member the library author
    /// explicitly annotated `T?` (`[Nullable(2)]`), dereferenced with
    /// no narrowing and no nil check. ADR-0186 step 4 kept it because cs2gs
    /// output depended on it; #4356 fixed cs2gs and deleted it. An annotated
    /// `T?` read now needs the same proof a source-declared `T?`
    /// always did.
    ///
    /// Both call sites are covered — the read path and
    /// `BindMemberFieldAssignmentExpression`'s CLR-receiver arm — in both
    /// modes, against the purpose-built annotated fixture and against the real
    /// annotated BCL. The remedies (`!!`, `?.`, an `if let`
    /// narrowing) are compiled and <em>run</em>, and the receiver's static type
    /// is asserted to stay `T?`: ADR-0186 leaves annotated members as they
    /// are, this only stops member lookup from ignoring what they say.
    @Fact
    func Issue4356_AChainThroughAnAnnotatedNullableClrMember_Reports() {
        const fixtureRead = "    let a = Annotated()\n    Console.WriteLine(a.MaybeText.Length)"
        const bclRead = "    let e = Exception(\"outer\", InvalidOperationException(\"inner\"))\n    Console.WriteLine(e.InnerException.Message)"
        const fixtureWrite = "    let a = Annotated()\n    a.MaybeNumbers.Capacity = 4"
        const bclWrite = "    let e = Exception(\"outer\", InvalidOperationException(\"inner\"))\n    e.InnerException.Source = \"src\""
        const remedies = `    let a = Annotated()
    a.MaybeNumbers!!.Capacity = 4
    Console.WriteLine(a.MaybeNumbers!!.Capacity)
    let e = Exception("outer", InvalidOperationException("inner"))
    e.InnerException!!.Source = "src"
    Console.WriteLine(e.InnerException?.Source)
    if let inner = e.InnerException {
        Console.WriteLine(inner.Message)
    }`
        using let world = World()
        for mode in[]NullabilityMode{NullabilityMode.Enabled, NullabilityMode.PlatformTypes} {
            for (body, member) in[](string, string){
                (fixtureRead, "Length"),
                (bclRead, "Message"),
                (fixtureWrite, "Capacity"),
                (bclWrite, "Source")
            } {
                let compiled = world.Compile(body, mode)
                Assert.False(compiled.Success, body)
                Assert.Contains(
                    compiled.Diagnostics,
                    (d DiagnosticLine) -> d.Id == "GS0158" && d.Message.Contains(member, StringComparison.Ordinal)
                )
            }
            Assert.Equal(
                []string{"4", "src", "inner"},
                world.Run(remedies, mode).Split(
                    '\n',
                    StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries
                )
            )
            Assert.IsType[NullableTypeSymbol](world.GlobalProbeType("let probe = Annotated().MaybeText", mode))
        }
    }

    /// <b>Issue #4356 — a nullable type argument substituted into a plain
    /// generic member reports too.</b>
    ///
    /// `Box<T>.Value` and `.Field` are declared plain
    /// `T`, with no `[Nullable(2)]`. On a `Box[List[int32]?]`
    /// receiver the member lookup keeps the receiver-supplied `?`
    /// (`NullableFlagsBuilder.MergeDeclarationNullability`), so the read
    /// is `T?` — nullability the G# author wrote in source. It used to
    /// continue its chain through the same deleted disjunct because the read is
    /// a `BoundClrPropertyAccessExpression`; it now needs the same proof
    /// any `T?` does.
    @Fact
    func Issue4356_AChainThroughANullableGenericSubstitution_Reports() {
        const read = `    let b = Box[List[int32]?]()
    b.Value = List[int32]()
    Console.WriteLine(b.Value.Capacity)`
        const write = `    let b = Box[List[int32]?]()
    b.Field = List[int32]()
    b.Field.Capacity = 5`
        const remedies = `    let b = Box[List[int32]?]()
    b.Value = List[int32]()
    b.Field = List[int32]()
    b.Value!!.Capacity = 4
    b.Field!!.Capacity = 5
    Console.WriteLine(b.Value!!.Capacity)
    Console.WriteLine(b.Field?.Count)`
        const entryRead = `    let b = Box[Entry?]()
    b.Value = Entry{Id: 7}
    Console.WriteLine(b.Value.Id)`
        const entryRemedy = `    let b = Box[Entry?]()
    b.Value = Entry{Id: 7}
    Console.WriteLine(b.Value!!.Id)`
        using let world = World()
        for mode in[]NullabilityMode{NullabilityMode.Enabled, NullabilityMode.PlatformTypes} {
            for (body, member) in[](string, string){(read, "Capacity"), (write, "Capacity")} {
                let compiled = world.Compile(body, mode)
                Assert.False(compiled.Success, body)
                Assert.Contains(
                    compiled.Diagnostics,
                    (d DiagnosticLine) -> d.Id == "GS0158" && d.Message.Contains(member, StringComparison.Ordinal)
                )
            }
            Assert.Equal(
                []string{"4", "0"},
                world.Run(remedies, mode).Split(
                    '\n',
                    StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries
                )
            )
            Assert.IsType[NullableTypeSymbol](
                world.GlobalProbeType("let b = Box[List[int32]?]()\nlet probe = b.Value", mode)
            )
            // The same substitution over a SAME-COMPILATION G# class: the
            // imported read `b.Value` projects to the G# `Entry?`, and member
            // lookup then goes through TryGetUserInstanceMemberReceiverType, not
            // CanBindClrInstanceMember. Its twin arm (#4121) accepted a
            // nullable receiver when it was a BoundClrPropertyAccessExpression;
            // #4356 deleted it too, so this reports like the CLR case.
            let projected = world.Compile(entryRead, mode, extraDeclarations: EntryDeclaration)
            Assert.False(projected.Success, Describe(projected))
            Assert.Contains(
                projected.Diagnostics,
                (d DiagnosticLine) -> d.Id == "GS0158" && d.Message.Contains("Id", StringComparison.Ordinal)
            )
            Assert.Equal("7", world.Run(entryRemedy, mode, extraDeclarations: EntryDeclaration).Trim())
        }
    }

    /// <b>ADR-0186 step 4 — the discriminator: an OBLIVIOUS field-read
    /// receiver is checked, not waved through.</b>
    ///
    /// `Ob.ArrField` and `Ob.NilNestField` are imported <em>field
    /// reads</em> — the receiver kind the deleted carve-out used to admit —
    /// over nullability-oblivious metadata, and deliberately not locals.
    ///
    /// Under the default mode the receiver is `T!`, a §4 check is
    /// inserted for it, and a nil one throws the attributed
    /// `NullReferenceException`: the platform coercion answers its safety
    /// question. The stated-nullable counterparts in
    /// (cref:Issue4356_AChainThroughAnAnnotatedNullableClrMember_Reports)
    /// and (cref:Issue4356_AChainThroughANullableGenericSubstitution_Reports)
    /// are the other half: `T?`, reported.
    ///
    /// Under `--nullability=enabled` the same field is ADR-0136's
    /// `string[]?`. Before #4356 it bound through the carve-out; it now
    /// reports like any `T?` receiver, which is what ADR-0136 always said
    /// it should do, and `!!` is the remedy there.
    @Fact
    func Step4_AnObliviousFieldReadReceiver_Is_Checked_Not_WavedThrough() {
        const body = "    Console.WriteLine(Ob.ArrField.Length)"
        const nilBody = "    Console.WriteLine(Ob.NilNestField.Prop)"
        using let world = World()
        Assert.IsType[PlatformTypeSymbol](
            world.GlobalProbeType("let probe = Ob.ArrField", NullabilityMode.PlatformTypes)
        )
        Assert.Equal(1, world.CountPlatformChecks(body))
        Assert.Equal("1", world.Run(body, NullabilityMode.PlatformTypes).Trim())
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return world.Run(nilBody, NullabilityMode.PlatformTypes)
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal)
        Assert.IsType[NullableTypeSymbol](world.GlobalProbeType("let probe = Ob.ArrField", NullabilityMode.Enabled))
        let enabled = world.Compile(body, NullabilityMode.Enabled)
        Assert.False(enabled.Success, Describe(enabled))
        Assert.Contains(
            enabled.Diagnostics,
            (d DiagnosticLine) -> d.Id == "GS0158" && d.Message.Contains("Length", StringComparison.Ordinal)
        )
        Assert.Equal("1", world.Run("    Console.WriteLine(Ob.ArrField!!.Length)", NullabilityMode.Enabled).Trim())
    }

    private data class DiagnosticLine(Id string, Message string) : IEquatable[DiagnosticLine] { }

    private data class CompiledProgram(
        Success bool,
        Diagnostics IReadOnlyList[DiagnosticLine],
        PeBytes[]uint8
    ) : IEquatable[CompiledProgram] { }

    /// The oblivious library plus the machinery to compile and run a G# probe
    /// against it in either nullability mode.
    private class World : IDisposable {
        private let directory string

        internal init() {
            this.directory = Path.Combine(
                AppContext.BaseDirectory,
                "Adr0186PlatformTypeBindingTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(this.directory)
            this.LibraryPath = EmitCSharpLibrary(
                this.directory,
                Adr0186PlatformTypeBindingTests.Library,
                Adr0186PlatformTypeBindingTests.LibrarySource
            )
        }

        internal prop LibraryPath string {
            get;
        }

        /// Gets the display string of the last (cref:GlobalProbeType) result.
        private var _lastProbeDisplay string = string.Empty

        internal prop LastProbeDisplay string {
            get {
                return _lastProbeDisplay
            }
            private set {
                _lastProbeDisplay = value
            }
        }

        func Dispose() {
            try {
                Directory.Delete(this.directory, recursive: true)
            } catch (IOException) {
                // A locked assembly on a test host is not a test failure.

            } catch (UnauthorizedAccessException) { }
        }

        internal func Compile(
            body string,
            mode NullabilityMode,
            extraDeclarations string = "",
            platformNilChecks bool = true
        ) CompiledProgram {
            using let resolver = ReferenceResolver.WithReferences([]string{this.LibraryPath})
            resolver.CurrentAssemblyName = Adr0186PlatformTypeBindingTests.Consumer
            let compilation = GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, extraDeclarations)))
            ){
                AssemblyName = Adr0186PlatformTypeBindingTests.Consumer,
                Nullability = mode,
                PlatformNilChecks = platformNilChecks
            }
            using let pe = MemoryStream()
            let emit = compilation.Emit(
                pe,
                pdbStream: nil,
                refStream: nil,
                assemblyName: Adr0186PlatformTypeBindingTests.Consumer
            )
            return CompiledProgram(
                emit.Success,
                emit
                    .Diagnostics
                    .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> DiagnosticLine(d.Id, d.Message))
                    .ToArray(),
                if emit.Success {
                    pe.ToArray()
                } else {
                    Array.Empty[uint8]()
                }
            )
        }

        internal func Run(
            body string,
            mode NullabilityMode,
            extraDeclarations string = "",
            platformNilChecks bool = true
        ) string {
            let compiled = this.Compile(body, mode, extraDeclarations, platformNilChecks)
            Assert.True(compiled.Success, Adr0186PlatformTypeBindingTests.Describe(compiled))
            let context = AssemblyLoadContext(
                "Adr0186PlatformTypeBindingTests" + "-" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            // Load the oblivious library from BYTES, not from its path, so the
            // file stays deletable: a path load keeps the DLL locked until the
            // collectible context finishes unloading, `Dispose` then fails to
            // delete the directory, and the swallowed failure leaks one
            // workspace per test case. This mirrors `EmittedFixture.Load`'s
            // existing comment, which is there for the same reason.
            let libraryImage = File.ReadAllBytes(this.LibraryPath)
            context.Resolving += (loadContext AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                name.Name,
                Adr0186PlatformTypeBindingTests.Library,
                StringComparison.Ordinal
            ) {
                loadContext.LoadFromStream(MemoryStream(libraryImage))
            } else {
                default(Assembly?)
            }
            try {
                using let peStream = MemoryStream(compiled.PeBytes)
                let assembly = context.LoadFromStream(peStream)
                let entry = Invariant.Required(
                    assembly.EntryPoint,
                    "an emitted G# program has an entry point",
                    expression: "assembly.EntryPoint"
                )
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry.Invoke(
                        nil,
                        if entry.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (invocation TargetInvocationException) when invocation.InnerException != nil {
                    // Surface the program's own exception, not the reflection
                    // wrapper — the §4 fixtures assert on its message.
                    throw invocation.InnerException
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                context.Unload()
            }
        }

        /// Binds [`globals`](paramref) as top-level statements and
        /// returns the inferred type of its `probe` global — the §5b
        /// observation, which has to read a TYPE and so cannot be made by
        /// running anything.
        /// @param globals Top-level G# statements declaring `probe`.
        /// @param mode The nullability mode.
        /// @returns The bound type of `probe`.
        internal func GlobalProbeType(globals string, mode NullabilityMode) TypeSymbol {
            using let resolver = ReferenceResolver.WithReferences([]string{this.LibraryPath})
            resolver.CurrentAssemblyName = Adr0186PlatformTypeBindingTests.Consumer
            let source = (`package ` + "${Adr0186PlatformTypeBindingTests.Consumer}" + `
import Adr0186.Step2.Library
import System
import System.Collections.Generic
import System.Linq

class Entry {
    var Id int32 = 1
}

` + "$globals")
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = Adr0186PlatformTypeBindingTests.Consumer,
                Nullability = mode
            }
            let scope_ = compilation.GlobalScope
            Assert.DoesNotContain(scope_.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            let type = Assert.Single(scope_.Variables, (v VariableSymbol) -> v.Name == "probe").Type
            // Rendered while the metadata context is still alive: an imported
            // type's display reads its CLR shape, which is gone once
            // `resolver` is disposed.
            this.LastProbeDisplay = GSharp.Core.CodeAnalysis.Symbols.Display.SymbolDisplay.ToTypeDisplayString(type)
            return type
        }

        /// Counts the ADR-0186 §4 checks the binder synthesized in
        /// [`body`](paramref). A synthesized check is the only one
        /// carrying a `PlatformCheckMessage`, so this counts exactly the
        /// coercions §4 inserted and never a user-written `!!`.
        /// @param body The probe body.
        /// @returns The number of inserted checks.
        internal func CountPlatformChecks(body string) int32 {
            using let resolver = ReferenceResolver.WithReferences([]string{this.LibraryPath})
            resolver.CurrentAssemblyName = Adr0186PlatformTypeBindingTests.Consumer
            let compilation = GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, string.Empty)))
            ){AssemblyName = Adr0186PlatformTypeBindingTests.Consumer, Nullability = NullabilityMode.PlatformTypes}
            let program = compilation.BoundProgram
            Assert.DoesNotContain(program.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            let counter = PlatformCheckCounter()
            for function in program.Functions {
                counter.Visit(function.Value)
            }
            return counter.Count
        }

        /// Counts synthesized ADR-0186 §4 checks in a bound body.
        private class PlatformCheckCounter : GSharp.Core.CodeAnalysis.Binding.BoundTreeWalker {
            internal prop Count int32 {
                get;
                private set;
            }

            protected override func VisitUnaryExpression(node BoundUnaryExpression) {
                if node.PlatformCheckMessage != nil {
                    this.Count++
                }
                base.VisitUnaryExpression(node)
            }
        }

        /// Binds [`body`](paramref) and reports the declaring type of the
        /// method a `Reverse()` call selected — §5a's structural half.
        /// @param body The probe body containing exactly one `Reverse()` call.
        /// @param mode The nullability mode.
        /// @returns The selected method's declaring type name.
        internal func SelectedReverseDeclaringType(body string, mode NullabilityMode) string {
            using let resolver = ReferenceResolver.WithReferences([]string{this.LibraryPath})
            resolver.CurrentAssemblyName = Adr0186PlatformTypeBindingTests.Consumer
            let compilation = GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, string.Empty)))
            ){AssemblyName = Adr0186PlatformTypeBindingTests.Consumer, Nullability = mode}
            let program = compilation.BoundProgram
            Assert.DoesNotContain(program.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            let collector = ReverseCallCollector()
            for function in program.Functions {
                collector.Visit(function.Value)
            }
            return Assert.Single(collector.Found)
        }

        /// Finds the declaring type of every `Reverse` call in a bound
        /// body. Both call shapes are collected on purpose: an own-surface
        /// instance call binds as `BoundImportedInstanceCallExpression`
        /// and an extension binds as `BoundClrStaticCallExpression`, so
        /// a collector that looked at only one would report "no call found"
        /// rather than "the wrong method" when §5a regresses.
        private class ReverseCallCollector : GSharp.Core.CodeAnalysis.Binding.BoundTreeWalker {
            init() {
                Found = List[string]()
            }

            internal prop Found List[string] {
                get;
            }

            protected override func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
                if node.Method.Name == "Reverse" {
                    this.Found.Add(node.Method.DeclaringType?.FullName ?? "<unknown>")
                }
                base.VisitImportedInstanceCallExpression(node)
            }

            protected override func VisitClrStaticCallExpression(node BoundClrStaticCallExpression) {
                if node.Method.Name == "Reverse" {
                    this.Found.Add(node.Method.DeclaringType?.FullName ?? "<unknown>")
                }
                base.VisitClrStaticCallExpression(node)
            }
        }

        shared {
            private func BuildSource(body string, extraDeclarations string) string -> (
                `package ` + "${Adr0186PlatformTypeBindingTests.Consumer}" + `
import Adr0186.Step2.Library
import System
import System.Collections.Generic
import System.Linq
import System.Linq.Expressions

func Main() {
` + "$body" + `
}

` + "$extraDeclarations"
            )

            private func EmitCSharpLibrary(directory string, assemblyName string, source string) string {
                let references = (
                    (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                        Array.Empty[string]()
                )
                    .Where(File.Exists).Select(
                    (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
                )
                let compilation = CSharpCompilation.Create(
                    assemblyName,
                    []Microsoft
                        .CodeAnalysis
                        .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                    references,
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                let path = Path.Combine(directory, assemblyName + ".dll")
                using let stream = File.Create(path)
                let emit = compilation.Emit(stream)
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
                return path
            }
        }
    }

    shared {
        private const Consumer string = "Adr0186.Step2.Consumer"
        private const Library string = "Adr0186.Step2.Library"

        /// A nullability-<em>oblivious</em> library: no `[Nullable]` and no
        /// `[NullableContext]` reaches any member, so the flags array gsc
        /// reads is empty and every reference position is oblivious — ADR-0186
        /// §2's first table row, which is the only producer of `T!` that
        /// exists before §9.
        private const LibrarySource string = (`#nullable disable
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

    // A non-nil ` + "`" + `List<string>` + "`" + `, for probes about the CONTAINER's
    // element nullability rather than about the container being nil.
    public static List<string> Strings() => new List<string> { "a", null };

    public static Nested NilNest() => null;

    public static Nested Nest2() => new Nested();

    public static string[] ArrWithNil() => new string[] { null };

    public static string[] ArrField = new string[] { null };

    // A nil oblivious FIELD, so a chained read through it reaches
    // member lookup as an imported field-read receiver — the kind
    // ` + "`" + `CanBindClrInstanceMember` + "`" + `'s deleted carve-out used to admit.
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

    // A REFERENCE deconstructible. ` + "`" + `ValueTuple` + "`" + ` is a struct, so it is
    // never nil and never platform-typed (ADR-0186 §2 excludes value
    // types) — a deconstruction-source check has nothing to bite on
    // there, and a fixture built only on ` + "`" + `Pair()` + "`" + ` would witness
    // nothing.
    public static Pt Pt2() => new Pt();

    public static Pt NilPt() => null;

    // Issue #4324's shape, as a value rather than a literal, so the
    // operand really is ` + "`" + `string!` + "`" + ` and not a constant.
    public static string Suffix() => "x";

    // Issue #4361: OPEN type-parameter slots in an unannotated
    // declaration — ` + "`" + `Array.Empty<T>` + "`" + `, ` + "`" + `Enumerable.Empty<T>` + "`" + `,
    // ` + "`" + `Array.FindAll<T>` + "`" + ` and FsCheck's ` + "`" + `Arb.From<T>` + "`" + ` shapes. The
    // element/argument nullability arrives with the type argument
    // (ADR-0186 §2); only the concrete container position is oblivious.
    public static T[] EmptyArr<T>() => new T[0];

    public static IEnumerable<T> EmptySeq<T>() => new T[0];

    public static T[] Same<T>(T[] values) => values;

    public static Holder<T> Hold<T>(T value) => new Holder<T> { Value = value };

    // The receiver/value-position audit (issues #4323/#4325, and the
    // Adr0186PlatformTypeBindingTests.PositionAudit fixture): one nil
    // and one live source per remaining position shape.
    public static Dictionary<string, int> NilTable() => null;

    public static Slot NilSlot() => null;

    public static Slot Slot2() => new Slot();

    public static Fns EmptyFns() => new Fns();

    public static Fns LiveFns() => new Fns { F = () => "F", P = () => "P" };

    public static Fns NilFns() => null;

    public static Func<string> StaticFn;

    public static IAsyncEnumerable<int> NilStream() => null;

    public static async IAsyncEnumerable<int> LiveStream()
    {
        yield return 1;
        await System.Threading.Tasks.Task.Yield();
        yield return 2;
    }

    public static IDisposable NilDisposable() => null;

    public static Res Res2() => new Res();

    public static System.Threading.Tasks.Task<string> NilTask() => null;

    public static System.Threading.Tasks.Task<string> LiveTask()
        => System.Threading.Tasks.Task.FromResult("T");

    public static object NilObj() => null;

    public static object Obj() => "O";
}

public class Holder<T>
{
    public T Value;
}

// A plain oblivious FIELD (not a property), for the field-store and
// field compound-assignment receiver shapes.
public class Slot
{
    public string Text = "S";

    public int Count;
}

// Delegate-typed members: invoking a member VALUE is a different
// binder path from invoking a local or a call result.
public class Fns
{
    public Func<string> F;

    public Func<string> P { get; set; }
}

public class Res : IDisposable
{
    public void Dispose() => Console.WriteLine("disposed");
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
// oblivious ` + "`" + `List<string>` + "`" + ` parameter would project to the same
// ` + "`" + `List[string!]!` + "`" + ` the argument already has, and a rule about two
// DIFFERENT nullabilities cannot be witnessed by a pair that agrees.
//
// The set-only ` + "`" + `int` + "`" + ` indexer is the load-bearing part. Index
// resolution only takes the symbolic path when some argument has no
// ` + "`" + `ClrType` + "`" + ` or when the type has a set-only indexer, and a
// ` + "`" + `List[string!]!` + "`" + ` argument always has a ` + "`" + `ClrType` + "`" + ` — so without this
// member the access is resolved by reflection against the erased CLR
// shape, where ` + "`" + `List<string>` + "`" + ` is ` + "`" + `List<string>` + "`" + ` and neither rule is
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

// The same ` + "`" + `List<string>` + "`" + ` parameter, but now with a legal competitor.
// Applicability and the later argument conversion are two different
// steps, and only SELECTION can tell them apart: an over-accepted
// ` + "`" + `List[string]` + "`" + ` candidate wins the ranking and takes the whole access
// down with it, where rejecting it correctly leaves ` + "`" + `object` + "`" + ` to bind.
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
// two stated-nullable populations ` + "`" + `CanBindClrInstanceMember` + "`" + `'s
// ` + "`" + `BoundClrPropertyAccessExpression` + "`" + ` carve-out waved through unchecked
// (the other is ` + "`" + `Box<T>` + "`" + ` below); ADR-0186 step 4 kept the carve-out
// for it, and #4356 deleted it, so a chained read through it now
// reports like any ` + "`" + `T?` + "`" + `.
public class Annotated
{
    public List<int>? MaybeNumbers { get; set; } = new List<int> { 1, 2, 3 };

    public string? MaybeText { get; set; } = "v";
}

// The carve-out's other stated-nullable population: a plain generic ` + "`" + `T` + "`" + ` member whose
// nullability comes from the RECEIVER's explicitly nullable type
// argument (` + "`" + `Box[List[int32]?].Value` + "`" + ` is ` + "`" + `List[int32]?` + "`" + `), not from any
// ` + "`" + `[Nullable(2)]` + "`" + ` on the declaration.
public class Box<T>
{
    public T Value { get; set; }

    public T Field;
}`)

        private const EntryDeclaration string = `class Entry {
    var Id int32
}`

        /// Unwraps the reflection/target-invocation wrappers a run adds.
        /// @param failure The thrown exception.
        /// @returns The innermost exception.
        private func Unwrap(failure Exception) Exception {
            var current = failure
            while current.InnerException is {} inner {
                current = inner
            }
            return current
        }

        private const NilHelpers string = `func takesString(s string) {
    Console.WriteLine(s)
}

func takesNilable(s string?) {
    Console.WriteLine("nilable")
}

func returnsString() string {
    return Ob.Nil()
}`

        private func Describe(compiled CompiledProgram) string -> string.Join(
            Environment.NewLine,
            compiled.Diagnostics.Select((d DiagnosticLine) -> d.Id + ": " + d.Message)
        )
    }
}
