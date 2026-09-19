// <copyright file="Adr0186PlatformTypeConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 §3's conversion table, asserted directly on
/// <see cref="Conversion.Classify"/>.
/// <para>
/// <b>Why at the classifier and not only end-to-end.</b> ADR-0186 §4's
/// coercion check is inserted <em>at</em> the classification — the binder asks
/// "does this conversion exist and does it need a check?" once, and every
/// coercion site inherits the answer. A classification that admits
/// <c>T! → T</c> without saying "check" is therefore not a missing diagnostic
/// that a later stage could still catch; it is a check that can never be
/// emitted anywhere, because the boundary the check hangs off was already
/// crossed. That property is only visible here.
/// </para>
/// <para>
/// <b>The regression this fixture exists for.</b> On ADR-0186 step 1's
/// baseline, <c>Conversion.Classify(string!, string)</c> answered a plain
/// <see cref="Conversion.Implicit"/> — an ordinary no-op reference upcast.
/// <see cref="PlatformTypeSymbol"/> relays its underlying's <c>ClrType</c>
/// (§1), so the two sides looked like one CLR type to the assignability arm
/// near the end of <c>ClassifyCore</c>, while the arm that rejects the
/// analogous <c>S? → S</c> (issue #1627's hole) tests
/// <c>is NullableTypeSymbol</c> and never matched. Every case below that
/// asserts <see cref="Conversion.RequiresPlatformNilCheck"/> turns red on that
/// baseline.
/// </para>
/// </summary>
public sealed class Adr0186PlatformTypeConversionTests
{
    /// <summary>
    /// §3 rule 3 does not reach a <b>value-type</b> container, because the
    /// rule's whole argument is aliasing and a struct is copied.
    /// <para>
    /// Rule 3 rejects <c>C[T!] → C[T]</c> because "two views alias one
    /// object": a nil written through one view is read as non-null through
    /// the other. Assigning a struct copies it, so the destination is a
    /// different object and there is no second view. §2 already excludes
    /// value types from this ADR; this is that exclusion applied to the
    /// container position.
    /// </para>
    /// <para>
    /// Measured, not hypothetical:
    /// <c>samples/NestedTypeOfConstructedGeneric.gs</c> stopped compiling
    /// under <c>/nullability:platform-types</c> with <em>"Cannot convert type
    /// 'Dictionary[string, int32].Enumerator' to
    /// 'Dictionary[string, int32].Enumerator'"</em> — the two sides differ
    /// only in an enclosing type argument's obliviousness, which a nested
    /// type's display does not render, so the diagnostic named one type
    /// twice.
    /// </para>
    /// <para>
    /// The <b>reference</b>-container control below is what keeps this a
    /// narrowing rather than a repeal: <c>List[string!] → List[string]</c>
    /// must still be rejected.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_AValueTypeContainer_Is_Outside_TheContainerRule()
    {
        var platformElement = PlatformTypeSymbol.Get(TypeSymbol.String);

        // A tuple is G#'s value-type container, and `TupleTypeSymbol.ClrType`
        // is a `ValueTuple<…>`.
        var fromTuple = TupleTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(platformElement, TypeSymbol.Int32));
        var toTuple = TupleTypeSymbol.Get(
            ImmutableArray.Create(TypeSymbol.String, TypeSymbol.Int32));

        var valueTypeContainer = Conversion.Classify(fromTuple, toTuple);
        Assert.True(valueTypeContainer.Exists, "a value-type container is copied, not aliased");

        // The control: a REFERENCE container in the same direction stays
        // rejected, so the gate above narrows rule 3 rather than repealing it.
        var referenceContainer = Conversion.Classify(
            SliceTypeSymbol.Get(platformElement),
            SliceTypeSymbol.Get(TypeSymbol.String));
        Assert.False(referenceContainer.Exists, "`[]string! -> []string` is rule 3's illegal direction");
    }

    /// <summary>
    /// §3's first row, and the prerequisite this whole step rests on:
    /// <c>T! → T</c> is implicit and <b>inserts a check</b>.
    /// </summary>
    [Fact]
    public void PlatformToUnderlying_Is_Implicit_And_Requires_A_Check()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        var conversion = Conversion.Classify(platform, TypeSymbol.String);

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);

        // Not identity. Two independent reasons, and each is a real bug if it
        // regresses: `BindConversion` returns the source expression untouched
        // on an identity classification (so the check would never
        // materialise), and the overload ranker prefers identity over
        // implicit (so §3's `T`-beats-`T?` tie-break would invert).
        Assert.False(conversion.IsIdentity);

        Assert.True(conversion.RequiresPlatformNilCheck);
    }

    /// <summary>
    /// §3's upcast rows — Copilot finding HIGH-1 against the ADR itself, and
    /// the reason §4's rule is stated over the <em>destination's</em>
    /// nullability rather than over the literal type <c>T</c>.
    /// <para>
    /// An earlier draft read the upcast as "as for <c>T</c>, no check", which
    /// contradicted the section's own rule and opened a real hole:
    /// <c>object o = obliviousCall()</c> stores a nil into a slot the program
    /// may read back as non-null indefinitely, with <b>no <c>T! → T</c>
    /// boundary ever having fired</b>. A destination that is a non-null
    /// reference type is a non-null reference destination whether it is
    /// <c>T</c>, a base class, or an interface.
    /// </para>
    /// </summary>
    [Fact]
    public void PlatformToNonNullSupertype_Requires_A_Check()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        var toObject = Conversion.Classify(platform, TypeSymbol.Object);

        Assert.True(toObject.Exists);
        Assert.True(toObject.IsImplicit);
        Assert.True(toObject.RequiresPlatformNilCheck);
    }

    /// <summary>
    /// The negative control for the row above: a <b>nilable</b> destination is
    /// not a non-null destination, so no conversion to non-null occurs and no
    /// check is inserted. Interop-to-interop flow costs nothing, which is
    /// what keeps §4's check count bounded.
    /// </summary>
    [Fact]
    public void PlatformToNilableDestinations_Never_Check()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        foreach (var destination in new TypeSymbol[]
        {
            NullableTypeSymbol.Get(TypeSymbol.String),
            NullableTypeSymbol.Get(TypeSymbol.Object),
            PlatformTypeSymbol.Get(TypeSymbol.String),
        })
        {
            var conversion = Conversion.Classify(platform, destination);
            Assert.True(conversion.Exists, destination.Name);
            Assert.True(conversion.IsImplicit, destination.Name);
            Assert.False(conversion.RequiresPlatformNilCheck, destination.Name);
        }
    }

    /// <summary>
    /// <c>T → T!</c> and <c>T? → T!</c>, both implicit and check-free.
    /// <para>
    /// <c>T? → T!</c> is the row that looks alarming and is in fact the point:
    /// an oblivious parameter genuinely admits nil — that is what oblivious
    /// <em>means</em> — so passing a <c>T?</c> to it is exactly correct.
    /// Requiring <c>!!</c> there is the ceremony ADR-0186 measures as the
    /// 12,100-assertion ceiling, and this single row removes the majority of
    /// cs2gs's argument-position assertions.
    /// </para>
    /// </summary>
    [Fact]
    public void ConversionsIntoAPlatformDestination_Are_Implicit_And_CheckFree()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        foreach (var source in new TypeSymbol[]
        {
            TypeSymbol.String,
            NullableTypeSymbol.Get(TypeSymbol.String),
        })
        {
            var conversion = Conversion.Classify(source, platform);
            Assert.True(conversion.Exists, source.Name);
            Assert.True(conversion.IsImplicit, source.Name);
            Assert.False(conversion.RequiresPlatformNilCheck, source.Name);
        }
    }

    /// <summary>
    /// §3's last row: <c>nil → T!</c> is an ordinary null store, no check.
    /// <para>
    /// Small and load-bearing. <c>nil</c> to a non-nullable <c>T</c> is a
    /// binder error, and ADR-0155 A9 records that <c>!!</c> cannot bridge it
    /// — "<c>!!</c> forgives a nullable value, and a literal <c>nil</c> has
    /// nothing to forgive." Without this row cs2gs could not translate
    /// <c>return null;</c> from an oblivious <c>string</c>-returning method
    /// and §9's whole oblivious-scope mechanism would be unusable.
    /// </para>
    /// </summary>
    [Fact]
    public void NilIntoAPlatformDestination_Is_An_Ordinary_Store()
    {
        var conversion = Conversion.Classify(
            TypeSymbol.Null,
            PlatformTypeSymbol.Get(TypeSymbol.String));

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
        Assert.False(conversion.RequiresPlatformNilCheck);
    }

    /// <summary>
    /// <c>T! → U</c> for an unrelated <c>U</c> is "whatever <c>T → U</c> is".
    /// The platform wrapper widens nothing: it must not make a conversion
    /// exist that would not exist for the bare underlying.
    /// </summary>
    [Fact]
    public void PlatformSource_Never_Invents_A_Conversion()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        var bare = Conversion.Classify(TypeSymbol.String, TypeSymbol.Bool);
        var wrapped = Conversion.Classify(platform, TypeSymbol.Bool);

        Assert.False(bare.Exists);
        Assert.False(wrapped.Exists);
    }

    /// <summary>
    /// ADR-0186 §3 rule 3, all six directions — the generic-container
    /// soundness fix (Copilot finding HIGH-2 against the ADR), pinned at the
    /// classifier because four of the six have no source spelling: <c>T!</c>
    /// is unwritable (§1), so no G# declaration can name a
    /// platform-argument parameter before §9's oblivious scope exists.
    /// <para>
    /// An earlier draft of the ADR made all three constructed forms mutually
    /// assignable, reasoning that they erase to one CLR type so nothing is
    /// observable at runtime. <b>Erasure is exactly what makes the hole
    /// reachable</b>: the two views alias one object, so a <c>nil</c> written
    /// through a <c>C[T?]</c> view is read as non-null through a <c>C[T]</c>
    /// view with <b>no <c>T! → T</c> boundary crossed anywhere</b>, and §4's
    /// check therefore never fires. Exactly one conversion survives.
    /// </para>
    /// </summary>
    [Fact]
    public void GenericContainers_Permit_Exactly_One_PlatformConversion()
    {
        var platform = ConstructedList(PlatformTypeSymbol.Get(TypeSymbol.String));
        var nonNull = ConstructedList(TypeSymbol.String);
        var nilable = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String));

        // Rule 2: the one legal conversion. Sound because every read through
        // the destination view has type `T?` and must be narrowed before
        // non-null use, so no view can produce an unchecked non-null read.
        var legal = Conversion.Classify(platform, nilable);
        Assert.True(legal.Exists);
        Assert.True(legal.IsImplicit);
        Assert.False(legal.RequiresPlatformNilCheck);

        // Rule 3, all three unsound directions.
        //   C[T!] -> C[T]  : a non-null read of a container that may hold nil.
        //   C[T]  -> C[T!] : `nil -> T!` deposits into a non-null view.
        //   C[T?] -> C[T!] : the same, one step further.
        Assert.False(Conversion.Classify(platform, nonNull).Exists);
        Assert.False(Conversion.Classify(nonNull, platform).Exists);
        Assert.False(Conversion.Classify(nilable, platform).Exists);

        // Rule 1's other half: identical platform-ness is an ordinary
        // identity and this arm must not disturb it.
        Assert.True(Conversion.Classify(platform, platform).IsIdentity);
    }

    /// <summary>
    /// The container rule must not <em>swallow</em> the top-level one.
    /// <para>
    /// An oblivious method returning <c>List&lt;string&gt;</c> produces
    /// <c>List[string!]!</c> — platform on the outside <b>and</b> in the type
    /// argument. The container arm runs first in <c>ClassifyCore</c> (it has
    /// to, because the annotation strip immediately below would hide the
    /// inner argument), so without a guard it answers the whole question from
    /// the arguments alone, returns a plain implicit conversion, and the
    /// top-level platform arm never runs. <c>let xs List[string?] =
    /// obliviousList()</c> would then store a nil into a declared slot with
    /// <b>no boundary fired anywhere</b> — HIGH-1's hole, one level up, and
    /// invisible to every test that looks only at the type arguments.
    /// </para>
    /// </summary>
    [Fact]
    public void AnOuterPlatformWrapper_Still_Checks_Even_When_TypeArguments_Also_Differ()
    {
        var source = PlatformTypeSymbol.Get(ConstructedList(PlatformTypeSymbol.Get(TypeSymbol.String)));
        var nonNullDestination = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String));

        var conversion = Conversion.Classify(source, nonNullDestination);

        // `List[string?]` is a non-null reference destination — the `?` is on
        // the ELEMENT, not on the container — so §4's rule applies to the
        // container itself.
        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
        Assert.True(conversion.RequiresPlatformNilCheck);

        // …and the container rule still bites through the outer wrapper: the
        // unsound inner direction is rejected whether or not the outer type
        // is platform-wrapped.
        Assert.False(Conversion.Classify(source, ConstructedList(TypeSymbol.String)).Exists);

        // A nilable OUTER destination takes no check, exactly as at the top
        // level, and still permits only the one inner direction.
        var nilableOuter = NullableTypeSymbol.Get(ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String)));
        var toNilableOuter = Conversion.Classify(source, nilableOuter);
        Assert.True(toNilableOuter.Exists);
        Assert.False(toNilableOuter.RequiresPlatformNilCheck);
    }

    /// <summary>
    /// Rule 2 applies <b>recursively</b> for nested type arguments: a nested
    /// platform argument widens with its container, and a nested unsound
    /// direction is rejected at any depth.
    /// </summary>
    [Fact]
    public void GenericContainers_Apply_The_Rule_Recursively()
    {
        var innerPlatform = ConstructedList(PlatformTypeSymbol.Get(TypeSymbol.String));
        var innerNilable = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String));
        var innerNonNull = ConstructedList(TypeSymbol.String);

        var outerPlatform = ConstructedList(innerPlatform);
        var outerNilable = ConstructedList(innerNilable);
        var outerNonNull = ConstructedList(innerNonNull);

        Assert.True(Conversion.Classify(outerPlatform, outerNilable).IsImplicit);
        Assert.False(Conversion.Classify(outerPlatform, outerNonNull).Exists);
        Assert.False(Conversion.Classify(outerNonNull, outerPlatform).Exists);
    }

    /// <summary>
    /// ADR-0186 §3 rule 3 for the <b>magic collection</b> kinds, pinned on
    /// synthesized symbols so it holds independently of which shape the
    /// metadata reader happens to produce.
    /// <para>
    /// This matters because the reader produces <em>two</em> shapes for one
    /// oblivious <c>string[]</c> depending on the path — a slice of platform
    /// elements at some sites, a platform-wrapped imported array at others
    /// (see the PR's F1b note). The rule has to hold for both, and asserting
    /// it here fixes the rule rather than the reader's current habits.
    /// </para>
    /// <para>
    /// A slice, a fixed array, a rectangular array and a map are containers
    /// with element positions exactly as a constructed generic is, but none
    /// of them carries a generic argument list — which is why the first
    /// version of this arm declined for all four and let them fall through to
    /// an equivalence arm that answered <em>identity</em>.
    /// </para>
    /// </summary>
    [Fact]
    public void MagicCollections_Follow_The_Same_ContainerRule_As_Generics()
    {
        var platformElement = PlatformTypeSymbol.Get(TypeSymbol.String);
        var nilableElement = NullableTypeSymbol.Get(TypeSymbol.String);

        foreach (var (platform, nonNull, nilable, kind) in new[]
        {
            (
                (TypeSymbol)SliceTypeSymbol.Get(platformElement),
                (TypeSymbol)SliceTypeSymbol.Get(TypeSymbol.String),
                (TypeSymbol)SliceTypeSymbol.Get(nilableElement),
                "slice"),
            (
                ArrayTypeSymbol.Get(platformElement, 3),
                ArrayTypeSymbol.Get(TypeSymbol.String, 3),
                ArrayTypeSymbol.Get(nilableElement, 3),
                "fixed array"),
            (
                MapTypeSymbol.Get(TypeSymbol.String, platformElement),
                MapTypeSymbol.Get(TypeSymbol.String, TypeSymbol.String),
                MapTypeSymbol.Get(TypeSymbol.String, nilableElement),
                "map"),
        })
        {
            // The one legal direction.
            var widening = Conversion.Classify(platform, nilable);
            Assert.True(widening.Exists, kind);
            Assert.True(widening.IsImplicit, kind);

            // The three unsound ones.
            Assert.False(Conversion.Classify(platform, nonNull).Exists, kind);
            Assert.False(Conversion.Classify(nonNull, platform).Exists, kind);
            Assert.False(Conversion.Classify(nilable, platform).Exists, kind);
        }
    }

    /// <summary>
    /// A container rule that <em>relates</em> two shapes it should not have
    /// matched would be worse than one that misses them, so the arm requires
    /// the same container KIND and the same non-element shape on both sides
    /// — a fixed array's length and a rectangular array's rank (issue #3962:
    /// <c>[3]T</c>, <c>[4]T</c> and <c>[]T</c> are all backed by <c>T[]</c>,
    /// so a CLR comparison alone collapses three distinct G# types into one).
    /// <para>
    /// Asserted <b>differentially</b> rather than as a flat rejection,
    /// because what matters is that this arm did not move the answer: for a
    /// pair it declines, the result must be exactly what the ordinary rules
    /// already gave the same pair without a platform element. (Those rules
    /// are more permissive here than they look — see the inner-nullability
    /// note below and issue #4321 — but that is theirs to answer, not this
    /// arm's to change.)
    /// </para>
    /// </summary>
    [Fact]
    public void MagicCollections_DeclineMismatchedShapes_Without_Changing_The_Answer()
    {
        var platformElement = PlatformTypeSymbol.Get(TypeSymbol.String);
        var nilableElement = NullableTypeSymbol.Get(TypeSymbol.String);

        // Different length.
        Assert.Equal(
            Conversion.Classify(
                ArrayTypeSymbol.Get(TypeSymbol.String, 3),
                ArrayTypeSymbol.Get(nilableElement, 4)).Exists,
            Conversion.Classify(
                ArrayTypeSymbol.Get(platformElement, 3),
                ArrayTypeSymbol.Get(nilableElement, 4)).Exists);

        // Different kind: a fixed array is not a slice.
        Assert.Equal(
            Conversion.Classify(
                ArrayTypeSymbol.Get(TypeSymbol.String, 3),
                SliceTypeSymbol.Get(nilableElement)).Exists,
            Conversion.Classify(
                ArrayTypeSymbol.Get(platformElement, 3),
                SliceTypeSymbol.Get(nilableElement)).Exists);
    }

    /// <summary>
    /// The container arm must never decide the OUTER nullability question.
    /// <para>
    /// <c>TryGetPlatformArgumentPairs</c> strips a top-level <c>?</c> from
    /// both sides — it has to, or <c>C[T!] → C[T?]?</c> could not be compared
    /// at all — and that strip was silently answering a question it had no
    /// business answering: a <c>C[T!]?</c> source reached a non-null
    /// <c>C[T?]</c> slot as an implicit conversion, because this arm replied
    /// before the ordinary nullable-to-non-null rejection ever ran. A nil
    /// CONTAINER then lands in a slot declared never to hold one.
    /// </para>
    /// <para>
    /// Asserted against the no-platform control, which is what makes the
    /// claim concrete: the identical pair without a platform argument is
    /// rejected today, so the platform version must be too.
    /// </para>
    /// </summary>
    [Fact]
    public void TheContainerRule_Does_Not_Decide_OuterNullability()
    {
        var platformElement = PlatformTypeSymbol.Get(TypeSymbol.String);
        var nilableElement = NullableTypeSymbol.Get(TypeSymbol.String);

        foreach (var (source, control, kind) in new[]
        {
            (
                (TypeSymbol)NullableTypeSymbol.Get(SliceTypeSymbol.Get(platformElement)),
                (TypeSymbol)NullableTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.String)),
                "slice"),
            (
                NullableTypeSymbol.Get(ConstructedList(platformElement)),
                NullableTypeSymbol.Get(ConstructedList(TypeSymbol.String)),
                "generic"),
        })
        {
            var target = kind == "slice"
                ? (TypeSymbol)SliceTypeSymbol.Get(nilableElement)
                : ConstructedList(nilableElement);

            // The control fixes what "correct" is here.
            Assert.False(Conversion.Classify(control, target).Exists, kind + " control");

            // …and the platform source must not be treated more leniently.
            Assert.False(Conversion.Classify(source, target).Exists, kind);
        }
    }

    /// <summary>
    /// A <c>Same</c> argument position means "no per-element check is needed
    /// here", never "these two types agree" — and one legitimately widening
    /// position must not carry an aggregate conversion whose other positions
    /// are unrelated.
    /// <para>
    /// Measured: <c>map[int32, string!] → map[string, string?]</c> was
    /// accepted, keys and all. The value pair widens legally under rule 2,
    /// and the key pair — <c>int32</c> against <c>string</c>, no relationship
    /// whatsoever — was marked <c>Same</c> purely because neither side
    /// carried a platform wrapper, and so was never validated.
    /// </para>
    /// </summary>
    [Fact]
    public void TheContainerRule_Validates_Every_PlatformFree_Position()
    {
        var platformElement = PlatformTypeSymbol.Get(TypeSymbol.String);
        var nilableElement = NullableTypeSymbol.Get(TypeSymbol.String);

        var source = MapTypeSymbol.Get(TypeSymbol.Int32, platformElement);
        var target = MapTypeSymbol.Get(TypeSymbol.String, nilableElement);

        // The control: the same unrelated key pair with no platform argument
        // anywhere is rejected, so the widening value pair must not rescue it.
        Assert.False(
            Conversion.Classify(
                MapTypeSymbol.Get(TypeSymbol.Int32, TypeSymbol.String),
                target).Exists,
            "control");

        Assert.False(Conversion.Classify(source, target).Exists);

        // The positive control: with the keys actually matching, rule 2's
        // widening still works — the fix must not have disabled the arm.
        Assert.True(
            Conversion.Classify(
                MapTypeSymbol.Get(TypeSymbol.String, platformElement),
                target).IsImplicit);
    }

    /// <summary>
    /// The container rule must not switch itself off for deeply nested
    /// generics.
    /// <para>
    /// The platform-detection walk was recursive with a depth cap, and
    /// answering <see langword="false"/> past the cap meant "no platform type
    /// here" — which every caller reads as "this arm has no business with
    /// this pair". So a <c>C[…[T!]…]</c> nested past the limit fell through
    /// to the ordinary rules, which erase inner nullability, and the whole
    /// check silently vanished for exactly the inputs most likely to hide a
    /// mistake. A guard against pathological input must never be spelled as a
    /// negative <em>answer</em> when the caller cannot distinguish the two.
    /// </para>
    /// <para>
    /// Twenty levels is comfortably past the old cap of sixteen. The walk is
    /// now iterative with a visited set, so the real hazard it was reaching
    /// for — a cyclic symbol graph, as CRTP produces — is handled exactly,
    /// with no limit and no wrong answers below one.
    /// </para>
    /// </summary>
    [Fact]
    public void TheContainerRule_Survives_DeepNesting()
    {
        TypeSymbol platform = PlatformTypeSymbol.Get(TypeSymbol.String);
        TypeSymbol nonNull = TypeSymbol.String;
        TypeSymbol nilable = NullableTypeSymbol.Get(TypeSymbol.String);

        for (var depth = 0; depth < 20; depth++)
        {
            platform = SliceTypeSymbol.Get(platform);
            nonNull = SliceTypeSymbol.Get(nonNull);
            nilable = SliceTypeSymbol.Get(nilable);
        }

        // Still rejected twenty levels down.
        Assert.False(Conversion.Classify(platform, nonNull).Exists);
        Assert.False(Conversion.Classify(nonNull, platform).Exists);

        // …and the one legal direction still works down there too.
        Assert.True(Conversion.Classify(platform, nilable).IsImplicit);
    }

    /// <summary>
    /// ADR-0186 §3 rule 4: <c>C[T] ↔ C[T?]</c> is "unchanged by this ADR",
    /// and this test records what "unchanged" actually is on this compiler so
    /// the container arm cannot quietly acquire responsibility for it.
    /// <para>
    /// <b>Measured, not assumed.</b> The ADR asserts that plain invariance
    /// "has always and correctly rejected" that pair. <em>That is not true of
    /// gsc.</em> <c>ClassifyCore</c> opens by stripping
    /// <c>NullabilityAnnotatedTypeSymbol</c> outright, on the documented
    /// ground that "inner generic nullability metadata does not change the
    /// outer CLR type's conversion rules", so <c>List[string]</c> and
    /// <c>List[string?]</c> convert freely in both directions — which is the
    /// aliasing hole §3 describes, minus the platform type, and reachable
    /// today with the flag off. Closing it is a change to <c>T?</c>'s own
    /// semantics, which ADR-0186 puts explicitly out of scope; it deserves
    /// its own issue rather than a silent fix smuggled in here.
    /// </para>
    /// <para>
    /// This test therefore pins the <em>status quo</em> deliberately. If a
    /// later change closes the pre-existing hole, this assertion should flip
    /// and the ADR's claim becomes true — which is exactly the signal wanted.
    /// </para>
    /// </summary>
    [Fact]
    public void GenericContainers_PreExistingInnerNullabilityLaxity_Is_Left_Unchanged()
    {
        var nonNull = ConstructedList(TypeSymbol.String);
        var nilable = ConstructedList(NullableTypeSymbol.Get(TypeSymbol.String));

        Assert.True(Conversion.Classify(nonNull, nilable).Exists);
        Assert.True(Conversion.Classify(nilable, nonNull).Exists);
    }

    /// <summary>Builds <c>List[argument]</c> with a symbolic type argument.</summary>
    /// <param name="argument">The element type.</param>
    /// <returns>The constructed generic symbol.</returns>
    private static TypeSymbol ConstructedList(TypeSymbol argument)
        => ImportedTypeSymbol.GetConstructed(
            typeof(List<string>),
            typeof(List<>),
            System.Collections.Immutable.ImmutableArray.Create(argument));

    /// <summary>
    /// The whole table is inert for value types. ADR-0186 §2 excludes them
    /// outright — a value-type position contributes no nullability byte, so
    /// there is no <c>int32!</c> — but a conversion classifier that reached a
    /// value destination and asked for a nil check would produce a
    /// <c>brtrue</c> on a struct, which is unverifiable IL rather than a
    /// merely wrong answer.
    /// </summary>
    [Fact]
    public void ValueTypeDestinations_Are_Never_Checked()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.Object);

        var conversion = Conversion.Classify(platform, TypeSymbol.Int32);

        Assert.False(conversion.RequiresPlatformNilCheck);
    }
}
