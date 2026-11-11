// <copyright file="Adr0186PlatformTypeConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// ADR-0186 §3's conversion table, asserted directly on
/// (cref:Conversion.Classify).
///
/// <b>Why at the classifier and not only end-to-end.</b> ADR-0186 §4's
/// coercion check is inserted <em>at</em> the classification — the binder asks
/// "does this conversion exist and does it need a check?" once, and every
/// coercion site inherits the answer. A classification that admits
/// `T! → T` without saying "check" is therefore not a missing diagnostic
/// that a later stage could still catch; it is a check that can never be
/// emitted anywhere, because the boundary the check hangs off was already
/// crossed. That property is only visible here.
///
/// <b>The regression this fixture exists for.</b> On ADR-0186 step 1's
/// baseline, `Conversion.Classify(string!, string)` answered a plain
/// (cref:Conversion.Implicit) — an ordinary no-op reference upcast.
/// (cref:PlatformTypeSymbol) relays its underlying's `ClrType`
/// (§1), so the two sides looked like one CLR type to the assignability arm
/// near the end of `ClassifyCore`, while the arm that rejects the
/// analogous `S? → S` (issue #1627's hole) tests
/// `is NullableTypeSymbol` and never matched. Every case below that
/// asserts (cref:Conversion.RequiresPlatformNilCheck) turns red on that
/// baseline.
class Adr0186PlatformTypeConversionTests {
    /// §3 rule 3 does not reach a <b>function shape</b>, in either
    /// direction, because a signature is not a container — and the residual
    /// hole that leaves is ADR-0186 <b>open question 13</b>, pinned here as
    /// the status quo rather than left untested.
    ///
    /// A `func` value or literal has no aliased object: converting to or
    /// from a function type is a <em>signature relation</em>, and its
    /// parameter/return compatibility is CLR delegate variance's question.
    /// The concrete regression this gate exists for is an ordinary lambda
    /// subscribed to an ordinary oblivious event —
    /// `Issue2585SemanticQualificationTests` reported <em>"Cannot
    /// convert type '(ViewModel) -&gt; void' to 'Action[ViewModel!]!'"</em>,
    /// because a `FunctionTypeSymbol`'s `ClrType` is the materialized
    /// delegate and rule 3 therefore read the pair as `C[T] → C[T!]`.
    ///
    /// <b>What is deliberately still open.</b> The second case below —
    /// a nested platform argument inside a function parameter position —
    /// converts, which means a callee could write nil through a view whose
    /// caller expects non-null elements. ADR-0186 open question 13 states
    /// exactly this and accepts it: <em>"delegate conversion … is a
    /// signature relation, not a value conversion, so there is no
    /// expression at which a `T! → T` check could be inserted … Kotlin has
    /// the identical hole."</em> Rule 3 catching a <em>subset</em> of those
    /// pairs — only the shapes the argument-pair walk recognises — would be
    /// an accident, not a design. Asserting it here means closing open
    /// question 13 flips a deliberate assertion.
    @Fact
    func Section3_AFunctionShape_Is_AConformanceBoundary_Not_AContainer() {
        let platformElement = PlatformTypeSymbol.Get(TypeSymbol.String)
        // The regression: a `(T) -> void` literal against a delegate-shaped
        // target whose parameter is `T!`. Modelled here as function-to-function
        // because that is the shape this classifier can be handed directly.
        let plainParameter = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String), TypeSymbol.Void)
        let platformParameter = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](platformElement),
            TypeSymbol.Void
        )
        Assert.True(
            Conversion.Classify(plainParameter, platformParameter).Exists,
            "a function shape is a signature relation, not a container"
        )
        // Open question 13's residual hole, pinned rather than hidden: a
        // platform argument NESTED in a function parameter position also
        // converts, with no check anywhere.
        let platformElementSlice = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](SliceTypeSymbol.Get(platformElement)),
            TypeSymbol.Void
        )
        let plainElementSlice = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](SliceTypeSymbol.Get(TypeSymbol.String)),
            TypeSymbol.Void
        )
        Assert.True(
            Conversion.Classify(platformElementSlice, plainElementSlice).Exists,
            "ADR-0186 open question 13: conformance boundaries have no check point, and this ADR does not close them"
        )
        // The control that keeps the gate narrow: the same element mismatch
        // in a plain container, with no function shape anywhere, is still
        // rule 3's illegal direction.
        Assert.False(
            Conversion.Classify(SliceTypeSymbol.Get(platformElement), SliceTypeSymbol.Get(TypeSymbol.String)).Exists,
            "`[]string! -> []string` outside a signature is still rejected"
        )
    }

    /// §3 rule 3 does not reach a <b>value-type</b> container, because the
    /// rule's whole argument is aliasing and a struct is copied.
    ///
    /// Rule 3 rejects `C[T!] → C[T]` because "two views alias one
    /// object": a nil written through one view is read as non-null through
    /// the other. Assigning a struct copies it, so the destination is a
    /// different object and there is no second view. §2 already excludes
    /// value types from this ADR; this is that exclusion applied to the
    /// container position.
    ///
    /// Measured, not hypothetical:
    /// `samples/NestedTypeOfConstructedGeneric.gs` stopped compiling
    /// under `/nullability:platform-types` with <em>"Cannot convert type
    /// 'Dictionary[string, int32].Enumerator' to
    /// 'Dictionary[string, int32].Enumerator'"</em> — the two sides differ
    /// only in an enclosing type argument's obliviousness, which a nested
    /// type's display does not render, so the diagnostic named one type
    /// twice.
    ///
    /// The <b>reference</b>-container control below is what keeps this a
    /// narrowing rather than a repeal: `List[string!] → List[string]`
    /// must still be rejected.
    @Fact
    func Section3_AValueTypeContainer_Is_Outside_TheContainerRule() {
        let platformElement = PlatformTypeSymbol.Get(TypeSymbol.String)
        // A tuple is G#'s value-type container, and `TupleTypeSymbol.ClrType`
        // is a `ValueTuple<…>`.
        let fromTuple = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](platformElement, TypeSymbol.Int32))
        let toTuple = TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String, TypeSymbol.Int32))
        let valueTypeContainer = Conversion.Classify(fromTuple, toTuple)
        Assert.True(valueTypeContainer.Exists, "a value-type container is copied, not aliased")
        // The control: a REFERENCE container in the same direction stays
        // rejected, so the gate above narrows rule 3 rather than repealing it.
        let referenceContainer = Conversion.Classify(
            SliceTypeSymbol.Get(platformElement),
            SliceTypeSymbol.Get(TypeSymbol.String)
        )
        Assert.False(referenceContainer.Exists, "`[]string! -> []string` is rule 3's illegal direction")
    }

    /// Nested relation aggregation never lets widening erase illegality.
    @Fact
    func Section3_NestedMixedRelations_RemainIllegal() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        let source = SliceTypeSymbol.Get(MapTypeSymbol.Get(TypeSymbol.String, platform))
        let wideningTarget = SliceTypeSymbol.Get(MapTypeSymbol.Get(platform, NullableTypeSymbol.Get(TypeSymbol.String)))
        let mixedTarget = SliceTypeSymbol.Get(MapTypeSymbol.Get(platform, TypeSymbol.String))
        Assert.True(
            Conversion.TryRelatePlatformContainer(
                source,
                wideningTarget,
                out var wideningIsImplicit,
                out var wideningRejectsImported
            )
        )
        Assert.False(wideningIsImplicit)
        Assert.False(wideningRejectsImported)
        Assert.True(
            Conversion.TryRelatePlatformContainer(
                source,
                mixedTarget,
                out var mixedIsImplicit,
                out var mixedRejectsImported
            )
        )
        Assert.False(mixedIsImplicit)
        Assert.True(mixedRejectsImported)
    }

    /// §3's first row, and the prerequisite this whole step rests on:
    /// `T! → T` is implicit and <b>inserts a check</b>.
    @Fact
    func PlatformToUnderlying_Is_Implicit_And_Requires_A_Check() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        let conversion = Conversion.Classify(platform, TypeSymbol.String)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
        // Not identity. Two independent reasons, and each is a real bug if it
        // regresses: `BindConversion` returns the source expression untouched
        // on an identity classification (so the check would never
        // materialise), and the overload ranker prefers identity over
        // implicit (so §3's `T`-beats-`T?` tie-break would invert).
        Assert.False(conversion.IsIdentity)
        Assert.True(conversion.RequiresPlatformNilCheck)
    }

    /// §3's upcast rows — Copilot finding HIGH-1 against the ADR itself, and
    /// the reason §4's rule is stated over the <em>destination's</em>
    /// nullability rather than over the literal type `T`.
    ///
    /// An earlier draft read the upcast as "as for `T`, no check", which
    /// contradicted the section's own rule and opened a real hole:
    /// `object o = obliviousCall()` stores a nil into a slot the program
    /// may read back as non-null indefinitely, with <b>no <c>T! → T</c>
    /// boundary ever having fired</b>. A destination that is a non-null
    /// reference type is a non-null reference destination whether it is
    /// `T`, a base class, or an interface.
    @Fact
    func PlatformToNonNullSupertype_Requires_A_Check() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        let toObject = Conversion.Classify(platform, TypeSymbol.Object)
        Assert.True(toObject.Exists)
        Assert.True(toObject.IsImplicit)
        Assert.True(toObject.RequiresPlatformNilCheck)
    }

    /// The negative control for the row above: a <b>nilable</b> destination is
    /// not a non-null destination, so no conversion to non-null occurs and no
    /// check is inserted. Interop-to-interop flow costs nothing, which is
    /// what keeps §4's check count bounded.
    @Fact
    func PlatformToNilableDestinations_Never_Check() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        for destination in[]TypeSymbol{
            NullableTypeSymbol.Get(TypeSymbol.String),
            NullableTypeSymbol.Get(TypeSymbol.Object),
            PlatformTypeSymbol.Get(TypeSymbol.String)
        } {
            let conversion = Conversion.Classify(platform, destination)
            Assert.True(conversion.Exists, destination.Name)
            Assert.True(conversion.IsImplicit, destination.Name)
            Assert.False(conversion.RequiresPlatformNilCheck, destination.Name)
        }
    }

    /// `T → T!` and `T? → T!`, both implicit and check-free.
    ///
    /// `T? → T!` is the row that looks alarming and is in fact the point:
    /// an oblivious parameter genuinely admits nil — that is what oblivious
    /// <em>means</em> — so passing a `T?` to it is exactly correct.
    /// Requiring `!!` there is the ceremony ADR-0186 measures as the
    /// 12,100-assertion ceiling, and this single row removes the majority of
    /// cs2gs's argument-position assertions.
    @Fact
    func ConversionsIntoAPlatformDestination_Are_Implicit_And_CheckFree() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        for source in[]TypeSymbol{TypeSymbol.String, NullableTypeSymbol.Get(TypeSymbol.String)} {
            let conversion = Conversion.Classify(source, platform)
            Assert.True(conversion.Exists, source.Name)
            Assert.True(conversion.IsImplicit, source.Name)
            Assert.False(conversion.RequiresPlatformNilCheck, source.Name)
        }
    }

    /// §3's last row: `nil → T!` is an ordinary null store, no check.
    ///
    /// Small and load-bearing. `nil` to a non-nullable `T` is a
    /// binder error, and ADR-0155 A9 records that `!!` cannot bridge it
    /// — "`!!` forgives a nullable value, and a literal `nil` has
    /// nothing to forgive." Without this row cs2gs could not translate
    /// `return null;` from an oblivious `string`-returning method
    /// and §9's whole oblivious-scope mechanism would be unusable.
    @Fact
    func NilIntoAPlatformDestination_Is_An_Ordinary_Store() {
        let conversion = Conversion.Classify(TypeSymbol.Null, PlatformTypeSymbol.Get(TypeSymbol.String))
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
        Assert.False(conversion.RequiresPlatformNilCheck)
    }

    /// `T! → U` for an unrelated `U` is "whatever `T → U` is".
    /// The platform wrapper widens nothing: it must not make a conversion
    /// exist that would not exist for the bare underlying.
    @Fact
    func PlatformSource_Never_Invents_A_Conversion() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        let bare = Conversion.Classify(TypeSymbol.String, TypeSymbol.Bool)
        let wrapped = Conversion.Classify(platform, TypeSymbol.Bool)
        Assert.False(bare.Exists)
        Assert.False(wrapped.Exists)
    }

    /// ADR-0186 §3 rule 3, all six directions — the generic-container
    /// soundness fix (Copilot finding HIGH-2 against the ADR), pinned at the
    /// classifier because four of the six have no source spelling: `T!`
    /// is unwritable (§1), so no G# declaration can name a
    /// platform-argument parameter before §9's oblivious scope exists.
    ///
    /// An earlier draft of the ADR made all three constructed forms mutually
    /// assignable, reasoning that they erase to one CLR type so nothing is
    /// observable at runtime. <b>Erasure is exactly what makes the hole
    /// reachable</b>: the two views alias one object, so a `nil` written
    /// through a `C[T?]` view is read as non-null through a `C[T]`
    /// view with <b>no <c>T! → T</c> boundary crossed anywhere</b>, and §4's
    /// check therefore never fires. Exactly one conversion survives.
    @Fact
    func GenericContainers_Permit_Exactly_One_PlatformConversion() {
        let platform = ConstructedList(PlatformTypeSymbol.Get(TypeSymbol.String))
        let nonNull = ConstructedList(TypeSymbol.String)
        let nilable = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String))
        // Rule 2: the one legal conversion. Sound because every read through
        // the destination view has type `T?` and must be narrowed before
        // non-null use, so no view can produce an unchecked non-null read.
        let legal = Conversion.Classify(platform, nilable)
        Assert.True(legal.Exists)
        Assert.True(legal.IsImplicit)
        Assert.False(legal.RequiresPlatformNilCheck)
        // Rule 3, all three unsound directions.
        //   C[T!] -> C[T]  : a non-null read of a container that may hold nil.
        //   C[T]  -> C[T!] : `nil -> T!` deposits into a non-null view.
        //   C[T?] -> C[T!] : the same, one step further.
        Assert.False(Conversion.Classify(platform, nonNull).Exists)
        Assert.False(Conversion.Classify(nonNull, platform).Exists)
        Assert.False(Conversion.Classify(nilable, platform).Exists)
        // Rule 1's other half: identical platform-ness is an ordinary
        // identity and this arm must not disturb it.
        Assert.True(Conversion.Classify(platform, platform).IsIdentity)
    }

    /// The container rule must not <em>swallow</em> the top-level one.
    ///
    /// An oblivious method returning `List<string>` produces
    /// `List[string!]!` — platform on the outside <b>and</b> in the type
    /// argument. The container arm runs first in `ClassifyCore` (it has
    /// to, because the annotation strip immediately below would hide the
    /// inner argument), so without a guard it answers the whole question from
    /// the arguments alone, returns a plain implicit conversion, and the
    /// top-level platform arm never runs. `let xs List[string?] =
    /// obliviousList()` would then store a nil into a declared slot with
    /// <b>no boundary fired anywhere</b> — HIGH-1's hole, one level up, and
    /// invisible to every test that looks only at the type arguments.
    @Fact
    func AnOuterPlatformWrapper_Still_Checks_Even_When_TypeArguments_Also_Differ() {
        let source = PlatformTypeSymbol.Get(ConstructedList(PlatformTypeSymbol.Get(TypeSymbol.String)))
        let nonNullDestination = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String))
        let conversion = Conversion.Classify(source, nonNullDestination)
        // `List[string?]` is a non-null reference destination — the `?` is on
        // the ELEMENT, not on the container — so §4's rule applies to the
        // container itself.
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
        Assert.True(conversion.RequiresPlatformNilCheck)
        // …and the container rule still bites through the outer wrapper: the
        // unsound inner direction is rejected whether or not the outer type
        // is platform-wrapped.
        Assert.False(Conversion.Classify(source, ConstructedList(TypeSymbol.String)).Exists)
        // A nilable OUTER destination takes no check, exactly as at the top
        // level, and still permits only the one inner direction.
        let nilableOuter = NullableTypeSymbol.Get(ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String)))
        let toNilableOuter = Conversion.Classify(source, nilableOuter)
        Assert.True(toNilableOuter.Exists)
        Assert.False(toNilableOuter.RequiresPlatformNilCheck)
    }

    /// Rule 2 applies <b>recursively</b> for nested type arguments: a nested
    /// platform argument widens with its container, and a nested unsound
    /// direction is rejected at any depth.
    @Fact
    func GenericContainers_Apply_The_Rule_Recursively() {
        let innerPlatform = ConstructedList(PlatformTypeSymbol.Get(TypeSymbol.String))
        let innerNilable = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String))
        let innerNonNull = ConstructedList(TypeSymbol.String)
        let outerPlatform = ConstructedList(innerPlatform)
        let outerNilable = ConstructedList(innerNilable)
        let outerNonNull = ConstructedList(innerNonNull)
        Assert.True(Conversion.Classify(outerPlatform, outerNilable).IsImplicit)
        Assert.False(Conversion.Classify(outerPlatform, outerNonNull).Exists)
        Assert.False(Conversion.Classify(outerNonNull, outerPlatform).Exists)
    }

    /// ADR-0186 §3 rule 3 for the <b>magic collection</b> kinds, pinned on
    /// synthesized symbols so it holds independently of which shape the
    /// metadata reader happens to produce.
    ///
    /// This matters because the reader produces <em>two</em> shapes for one
    /// oblivious `string[]` depending on the path — a slice of platform
    /// elements at some sites, a platform-wrapped imported array at others
    /// (see the PR's F1b note). The rule has to hold for both, and asserting
    /// it here fixes the rule rather than the reader's current habits.
    ///
    /// A slice, a fixed array, a rectangular array and a map are containers
    /// with element positions exactly as a constructed generic is, but none
    /// of them carries a generic argument list — which is why the first
    /// version of this arm declined for all four and let them fall through to
    /// an equivalence arm that answered <em>identity</em>.
    @Fact
    func MagicCollections_Follow_The_Same_ContainerRule_As_Generics() {
        let platformElement = PlatformTypeSymbol.Get(TypeSymbol.String)
        let nilableElement = NullableTypeSymbol.Get(TypeSymbol.String)
        for (platform, nonNull, nilable, kind) in[](TypeSymbol, TypeSymbol, TypeSymbol, string){
            (
                cast[TypeSymbol](SliceTypeSymbol.Get(platformElement)),
                cast[TypeSymbol](SliceTypeSymbol.Get(TypeSymbol.String)),
                cast[TypeSymbol](SliceTypeSymbol.Get(nilableElement)),
                "slice"
            ),
            (
                ArrayTypeSymbol.Get(platformElement, 3),
                ArrayTypeSymbol.Get(TypeSymbol.String, 3),
                ArrayTypeSymbol.Get(nilableElement, 3),
                "fixed array"
            ),
            (
                MapTypeSymbol.Get(TypeSymbol.String, platformElement),
                MapTypeSymbol.Get(TypeSymbol.String, TypeSymbol.String),
                MapTypeSymbol.Get(TypeSymbol.String, nilableElement),
                "map"
            )
        } {
            // The one legal direction.
            let widening = Conversion.Classify(platform, nilable)
            Assert.True(widening.Exists, kind)
            Assert.True(widening.IsImplicit, kind)
            // The three unsound ones.
            Assert.False(Conversion.Classify(platform, nonNull).Exists, kind)
            Assert.False(Conversion.Classify(nonNull, platform).Exists, kind)
            Assert.False(Conversion.Classify(nilable, platform).Exists, kind)
        }
    }

    /// A container rule that <em>relates</em> two shapes it should not have
    /// matched would be worse than one that misses them, so the arm requires
    /// the same container KIND and the same non-element shape on both sides
    /// — a fixed array's length and a rectangular array's rank (issue #3962:
    /// `[3]T`, `[4]T` and `[]T` are all backed by `T[]`,
    /// so a CLR comparison alone collapses three distinct G# types into one).
    ///
    /// Asserted <b>differentially</b> rather than as a flat rejection,
    /// because what matters is that this arm did not move the answer: for a
    /// pair it declines, the result must be exactly what the ordinary rules
    /// already gave the same pair without a platform element. (Those rules
    /// are more permissive here than they look — see the inner-nullability
    /// note below and issue #4321 — but that is theirs to answer, not this
    /// arm's to change.)
    @Fact
    func MagicCollections_DeclineMismatchedShapes_Without_Changing_The_Answer() {
        let platformElement = PlatformTypeSymbol.Get(TypeSymbol.String)
        let nilableElement = NullableTypeSymbol.Get(TypeSymbol.String)
        // Different length.
        Assert.Equal(
            Conversion.Classify(ArrayTypeSymbol.Get(TypeSymbol.String, 3), ArrayTypeSymbol.Get(nilableElement, 4))
                .Exists,
            Conversion.Classify(ArrayTypeSymbol.Get(platformElement, 3), ArrayTypeSymbol.Get(nilableElement, 4)).Exists
        )
        // Different kind: a fixed array is not a slice.
        Assert.Equal(
            Conversion.Classify(ArrayTypeSymbol.Get(TypeSymbol.String, 3), SliceTypeSymbol.Get(nilableElement)).Exists,
            Conversion.Classify(ArrayTypeSymbol.Get(platformElement, 3), SliceTypeSymbol.Get(nilableElement)).Exists
        )
    }

    /// The container arm must never decide the OUTER nullability question.
    ///
    /// `TryGetPlatformArgumentPairs` strips a top-level `?` from
    /// both sides — it has to, or `C[T!] → C[T?]?` could not be compared
    /// at all — and that strip was silently answering a question it had no
    /// business answering: a `C[T!]?` source reached a non-null
    /// `C[T?]` slot as an implicit conversion, because this arm replied
    /// before the ordinary nullable-to-non-null rejection ever ran. A nil
    /// CONTAINER then lands in a slot declared never to hold one.
    ///
    /// Asserted against the no-platform control, which is what makes the
    /// claim concrete: the identical pair without a platform argument is
    /// rejected today, so the platform version must be too.
    @Fact
    func TheContainerRule_Does_Not_Decide_OuterNullability() {
        let platformElement = PlatformTypeSymbol.Get(TypeSymbol.String)
        let nilableElement = NullableTypeSymbol.Get(TypeSymbol.String)
        for (source, control, kind) in[](TypeSymbol, TypeSymbol, string){
            (
                cast[TypeSymbol](NullableTypeSymbol.Get(SliceTypeSymbol.Get(platformElement))),
                cast[TypeSymbol](NullableTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.String))),
                "slice"
            ),
            (
                NullableTypeSymbol.Get(ConstructedList(platformElement)),
                NullableTypeSymbol.Get(ConstructedList(TypeSymbol.String)),
                "generic"
            )
        } {
            let target = if kind == "slice" {
                cast[TypeSymbol](SliceTypeSymbol.Get(nilableElement))
            } else {
                ConstructedList(nilableElement)
            }
            // The control fixes what "correct" is here.
            Assert.False(Conversion.Classify(control, target).Exists, kind + " control")
            // …and the platform source must not be treated more leniently.
            Assert.False(Conversion.Classify(source, target).Exists, kind)
        }
    }

    /// A `Same` argument position means "no per-element check is needed
    /// here", never "these two types agree" — and one legitimately widening
    /// position must not carry an aggregate conversion whose other positions
    /// are unrelated.
    ///
    /// Measured: `map[int32, string!] → map[string, string?]` was
    /// accepted, keys and all. The value pair widens legally under rule 2,
    /// and the key pair — `int32` against `string`, no relationship
    /// whatsoever — was marked `Same` purely because neither side
    /// carried a platform wrapper, and so was never validated.
    @Fact
    func TheContainerRule_Validates_Every_PlatformFree_Position() {
        let platformElement = PlatformTypeSymbol.Get(TypeSymbol.String)
        let nilableElement = NullableTypeSymbol.Get(TypeSymbol.String)
        let source = MapTypeSymbol.Get(TypeSymbol.Int32, platformElement)
        let target = MapTypeSymbol.Get(TypeSymbol.String, nilableElement)
        // The control: the same unrelated key pair with no platform argument
        // anywhere is rejected, so the widening value pair must not rescue it.
        Assert.False(
            Conversion.Classify(MapTypeSymbol.Get(TypeSymbol.Int32, TypeSymbol.String), target).Exists,
            "control"
        )
        Assert.False(Conversion.Classify(source, target).Exists)
        // The positive control: with the keys actually matching, rule 2's
        // widening still works — the fix must not have disabled the arm.
        Assert.True(Conversion.Classify(MapTypeSymbol.Get(TypeSymbol.String, platformElement), target).IsImplicit)
    }

    /// The container rule must not switch itself off for deeply nested
    /// generics.
    ///
    /// The platform-detection walk was recursive with a depth cap, and
    /// answering `false` past the cap meant "no platform type
    /// here" — which every caller reads as "this arm has no business with
    /// this pair". So a `C[…[T!]…]` nested past the limit fell through
    /// to the ordinary rules, which erase inner nullability, and the whole
    /// check silently vanished for exactly the inputs most likely to hide a
    /// mistake. A guard against pathological input must never be spelled as a
    /// negative <em>answer</em> when the caller cannot distinguish the two.
    ///
    /// Twenty levels is comfortably past the old cap of sixteen. The walk is
    /// now iterative with a visited set, so the real hazard it was reaching
    /// for — a cyclic symbol graph, as CRTP produces — is handled exactly,
    /// with no limit and no wrong answers below one.
    @Fact
    func TheContainerRule_Survives_DeepNesting() {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        var nonNull = TypeSymbol.String
        var nilable TypeSymbol = NullableTypeSymbol.Get(TypeSymbol.String)
        for var depth = 0; depth < 20; depth++ {
            platform = SliceTypeSymbol.Get(platform)
            nonNull = SliceTypeSymbol.Get(nonNull)
            nilable = SliceTypeSymbol.Get(nilable)
        }
        // Still rejected twenty levels down.
        Assert.False(Conversion.Classify(platform, nonNull).Exists)
        Assert.False(Conversion.Classify(nonNull, platform).Exists)
        // …and the one legal direction still works down there too.
        Assert.True(Conversion.Classify(platform, nilable).IsImplicit)
    }

    /// ADR-0186 §3 rule 4: `C[T] ↔ C[T?]` is "unchanged by this ADR",
    /// and this test records what "unchanged" actually is on this compiler so
    /// the container arm cannot quietly acquire responsibility for it.
    ///
    /// <b>Measured, not assumed.</b> The ADR asserts that plain invariance
    /// "has always and correctly rejected" that pair. <em>That is not true of
    /// gsc.</em> `ClassifyCore` opens by stripping
    /// `NullabilityAnnotatedTypeSymbol` outright, on the documented
    /// ground that "inner generic nullability metadata does not change the
    /// outer CLR type's conversion rules", so `List[string]` and
    /// `List[string?]` convert freely in both directions — which is the
    /// aliasing hole §3 describes, minus the platform type, and reachable
    /// today with the flag off. Closing it is a change to `T?`'s own
    /// semantics, which ADR-0186 puts explicitly out of scope; it deserves
    /// its own issue rather than a silent fix smuggled in here.
    ///
    /// This test therefore pins the <em>status quo</em> deliberately. If a
    /// later change closes the pre-existing hole, this assertion should flip
    /// and the ADR's claim becomes true — which is exactly the signal wanted.
    @Fact
    func GenericContainers_PreExistingInnerNullabilityLaxity_Is_Left_Unchanged() {
        let nonNull = ConstructedList(TypeSymbol.String)
        let nilable = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String))
        Assert.True(Conversion.Classify(nonNull, nilable).Exists)
        Assert.True(Conversion.Classify(nilable, nonNull).Exists)
    }

    /// The whole table is inert for value types. ADR-0186 §2 excludes them
    /// outright — a value-type position contributes no nullability byte, so
    /// there is no `int32!` — but a conversion classifier that reached a
    /// value destination and asked for a nil check would produce a
    /// `brtrue` on a struct, which is unverifiable IL rather than a
    /// merely wrong answer.
    @Fact
    func ValueTypeDestinations_Are_Never_Checked() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.Object)
        let conversion = Conversion.Classify(platform, TypeSymbol.Int32)
        Assert.False(conversion.RequiresPlatformNilCheck)
    }

    shared {
        /// Builds `List[argument]` with a symbolic type argument.
        /// @param argument The element type.
        /// @returns The constructed generic symbol.
        private func ConstructedList(argument TypeSymbol) TypeSymbol -> ImportedTypeSymbol.GetConstructed(
            typeof(List[string]),
            typeof(List[_]),
            ImmutableArray.Create(argument)
        )
    }
}
