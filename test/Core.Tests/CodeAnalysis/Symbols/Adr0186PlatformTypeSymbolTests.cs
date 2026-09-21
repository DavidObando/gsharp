// <copyright file="Adr0186PlatformTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0186 step 1: <see cref="PlatformTypeSymbol"/>, its display forms, and
/// <c>ClrNullability</c>'s three-state classifier.
/// <para>
/// <b>Why the classifier is asserted directly rather than through a
/// compilation.</b> ADR-0154 asks each test to name the wrong answer it would
/// catch. With <c>--nullability=platform-types</c> <b>off</b> — the default,
/// and the mode every other test in the suite runs under — the bytes <c>0</c>
/// and <c>2</c> deliberately produce the <em>same</em> symbol
/// (<see cref="NullableTypeSymbol"/>), because "no behaviour change when off"
/// is this step's load-bearing claim. A classifier that answered
/// <see cref="ClrNullabilityState.Annotated"/> for an oblivious byte would
/// therefore be completely invisible downstream while the flag is off. So the
/// witness has to live at the classifier's own return value, and the
/// symbol-level assertions have to run with the mode on.
/// </para>
/// <para>
/// <b>Step 2 has landed.</b> Conversions (§3), the coercion check (§4),
/// member lookup (§5) and operator acceptance (§6) are now taught about
/// <c>T!</c>, and they are covered end-to-end by
/// <c>Adr0186PlatformTypeConversionTests</c> (the §3 table and the
/// generic-container rule, at the classifier) and
/// <c>Adr0186PlatformTypeBindingTests</c> (§4's check, §5's two-clause
/// mutation witness and §6's operator matrix, against real oblivious
/// metadata). <em>This</em> fixture keeps its original scope deliberately —
/// the symbol, its display forms and the three-state classifier — because
/// those are the facts the rest of the design is derived from and they
/// deserve a witness that does not depend on any of it.
/// <para>
/// Still to come: step 3 flips the mode on by default, at which point the
/// mode-off assertions here become assertions about a mode nobody selects
/// and should be revisited rather than merely kept green.
/// </para>
/// </para>
/// </summary>
public class Adr0186PlatformTypeSymbolTests
{
    /// <summary>
    /// ADR-0186 §2's table, read directly. Each row names a <c>flags</c> shape
    /// and a position; the expected state is the ADR's own third column.
    /// <para>
    /// The oblivious rows are the discrimination witnesses: an implementation
    /// that folded oblivious into <see cref="ClrNullabilityState.Annotated"/> (the
    /// pre-ADR-0186 reading, where <c>0</c> and <c>2</c> were the same answer)
    /// turns every one of them red, while leaving the <c>1</c> and <c>2</c>
    /// rows — and every existing test in the suite — green.
    /// </para>
    /// </summary>
    /// <param name="flags">The nullable-flags byte array under test.</param>
    /// <param name="index">The DFS position index.</param>
    /// <param name="expected">The <c>ClrNullabilityState</c> ADR-0186 §2's table assigns to it, as its ordinal — the enum is internal to the compiler, and an internal type cannot appear in a public test signature.</param>
    [Theory]

    // Empty: no [Nullable] and no [NullableContext] anywhere.
    [InlineData(new byte[0], 0, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[0], 3, (int)ClrNullabilityState.Oblivious)]

    // Single scalar/context byte, which speaks for every position.
    [InlineData(new byte[] { 0 }, 0, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[] { 0 }, 7, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[] { 1 }, 0, (int)ClrNullabilityState.NotAnnotated)]
    [InlineData(new byte[] { 1 }, 7, (int)ClrNullabilityState.NotAnnotated)]
    [InlineData(new byte[] { 2 }, 0, (int)ClrNullabilityState.Annotated)]
    [InlineData(new byte[] { 2 }, 7, (int)ClrNullabilityState.Annotated)]

    // Per-position array, with 0/1/2 at every position in turn.
    [InlineData(new byte[] { 0, 1, 2 }, 0, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[] { 0, 1, 2 }, 1, (int)ClrNullabilityState.NotAnnotated)]
    [InlineData(new byte[] { 0, 1, 2 }, 2, (int)ClrNullabilityState.Annotated)]
    [InlineData(new byte[] { 1, 2, 0 }, 0, (int)ClrNullabilityState.NotAnnotated)]
    [InlineData(new byte[] { 1, 2, 0 }, 1, (int)ClrNullabilityState.Annotated)]
    [InlineData(new byte[] { 1, 2, 0 }, 2, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[] { 2, 0, 1 }, 0, (int)ClrNullabilityState.Annotated)]
    [InlineData(new byte[] { 2, 0, 1 }, 1, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[] { 2, 0, 1 }, 2, (int)ClrNullabilityState.NotAnnotated)]

    // Beyond the array: the declaration described no such position, which is
    // the same statement as describing none at all.
    [InlineData(new byte[] { 1, 1 }, 2, (int)ClrNullabilityState.Oblivious)]
    [InlineData(new byte[] { 2, 2 }, 9, (int)ClrNullabilityState.Oblivious)]
    public void ClassifyPosition_Matches_The_Adr0186_Table(
        byte[] flags,
        int index,
        int expected)
    {
        Assert.Equal(
            (ClrNullabilityState)expected,
            ClrNullability.ClassifyPosition(ImmutableArray.Create(flags), index));
    }

    /// <summary>
    /// A default (<c>IsDefault</c>, not merely empty) flags array is the shape
    /// several readers actually hand over, and it must not throw.
    /// </summary>
    [Fact]
    public void ClassifyPosition_Treats_A_Default_Array_As_Oblivious()
    {
        Assert.Equal(
            ClrNullabilityState.Oblivious,
            ClrNullability.ClassifyPosition(default, 0));
    }

    /// <summary>
    /// The per-byte classifier, which <c>NullableFlagsBuilder</c> uses because
    /// it reads bytes out of an already-expanded array and so has no position
    /// to classify.
    /// </summary>
    /// <param name="flag">The metadata byte.</param>
    /// <param name="expected">What it says, as a <c>ClrNullabilityState</c> ordinal.</param>
    [Theory]
    [InlineData((byte)0, (int)ClrNullabilityState.Oblivious)]
    [InlineData((byte)1, (int)ClrNullabilityState.NotAnnotated)]
    [InlineData((byte)2, (int)ClrNullabilityState.Annotated)]
    [InlineData((byte)7, (int)ClrNullabilityState.Oblivious)]
    public void ClassifyFlag_Maps_Each_Byte(byte flag, int expected)
        => Assert.Equal((ClrNullabilityState)expected, ClrNullability.ClassifyFlag(flag));

    /// <summary>
    /// ADR-0136's <c>IsFlagNonNull</c> / <c>IsPositionNonNull</c> are now
    /// projections of the classifier, and their answers are <b>unchanged</b> —
    /// which is what makes this step a no-op with the mode off. This pins the
    /// projection: exactly <see cref="ClrNullabilityState.NotAnnotated"/> is
    /// non-null, and the other two states are not.
    /// </summary>
    /// <param name="flag">The metadata byte.</param>
    /// <param name="expectedNonNull">Whether ADR-0136 calls it non-null.</param>
    [Theory]
    [InlineData((byte)0, false)]
    [InlineData((byte)1, true)]
    [InlineData((byte)2, false)]
    public void IsFlagNonNull_Is_Unchanged_By_The_Three_State_Read(byte flag, bool expectedNonNull)
    {
        Assert.Equal(expectedNonNull, ClrNullability.IsFlagNonNull(flag));
        Assert.Equal(
            expectedNonNull,
            ClrNullability.IsPositionNonNull(ImmutableArray.Create(flag), 0));
    }

    /// <summary>
    /// The mode-off half of ADR-0186 step 1's central claim: an oblivious
    /// position still produces exactly what it produces today, <c>T?</c> via
    /// <see cref="NullableTypeSymbol"/>, indistinguishable from an explicitly
    /// annotated one.
    /// </summary>
    /// <param name="state">The declaration's state, as a <c>ClrNullabilityState</c> ordinal.</param>
    [Theory]
    [InlineData((int)ClrNullabilityState.Oblivious)]
    [InlineData((int)ClrNullabilityState.Annotated)]
    public void SymbolForState_Yields_Nullable_For_Both_NonNonNull_States_When_The_Mode_Is_Off(
        int state)
    {
        var symbol = ClrNullability.SymbolForState(TypeSymbol.String, (ClrNullabilityState)state);
        Assert.IsType<NullableTypeSymbol>(symbol);
        Assert.Same(NullableTypeSymbol.Get(TypeSymbol.String), symbol);
    }

    /// <summary>
    /// The mode-on half: oblivious becomes <c>T!</c> and <em>only</em>
    /// oblivious does. The <c>Annotated</c> and <c>NotAnnotated</c> rows are
    /// the negative controls — ADR-0186 changes exactly one cell of ADR-0136's
    /// table, so an implementation that widened the pivot to the annotated
    /// states (un-annotating the BCL, which the ADR explicitly forbids) fails
    /// here.
    /// </summary>
    [Fact]
    public void SymbolForState_Yields_PlatformType_For_Oblivious_Only_When_The_Mode_Is_On()
    {
        using var scope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);

        var platform = ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious);
        Assert.IsType<PlatformTypeSymbol>(platform);
        Assert.Same(TypeSymbol.String, ((PlatformTypeSymbol)platform).UnderlyingType);

        Assert.IsType<NullableTypeSymbol>(
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Annotated));
        Assert.Same(
            TypeSymbol.String,
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.NotAnnotated));
    }

    /// <summary>
    /// The mode is scoped, not global: leaving the scope restores the previous
    /// reading. Without this, one test turning the mode on would silently
    /// change what every later test in the same process imports.
    /// </summary>
    [Fact]
    public void The_Mode_Is_Restored_When_Its_Scope_Ends()
    {
        Assert.False(NullabilityOptions.PlatformTypesEnabled);
        using (NullabilityOptions.Enter(NullabilityMode.PlatformTypes))
        {
            Assert.True(NullabilityOptions.PlatformTypesEnabled);
        }

        Assert.False(NullabilityOptions.PlatformTypesEnabled);
        Assert.IsType<NullableTypeSymbol>(
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious));
    }

    /// <summary>
    /// ADR-0186 §1: <c>T!</c> is reference-unique per underlying type.
    /// <c>SymbolEqualityComparer.Default</c> is <c>ReferenceEquals</c>, so two
    /// independently-constructed wrappers over one underlying type would be two
    /// different types to every symbol set and identity comparison in the
    /// binder. <c>Get</c> is also idempotent over its own wrapper, exactly as
    /// <see cref="NullableTypeSymbol.Get"/> is.
    /// </summary>
    [Fact]
    public void Get_Is_Cached_And_Idempotent()
    {
        var first = PlatformTypeSymbol.Get(TypeSymbol.String);
        var second = PlatformTypeSymbol.Get(TypeSymbol.String);
        Assert.Same(first, second);
        Assert.Same(first, PlatformTypeSymbol.Get(first));
        Assert.True(SymbolEqualityComparer.Default.Equals(first, second));

        // A different underlying type is a different platform type.
        Assert.NotSame(first, PlatformTypeSymbol.Get(TypeSymbol.Object));
    }

    /// <summary>
    /// ADR-0186 §1: the wrapper is a binder-level annotation only — its
    /// <see cref="TypeSymbol.ClrType"/> is the underlying type's, which is what
    /// makes it erase to <c>T</c> at emit.
    /// </summary>
    [Fact]
    public void ClrType_Is_The_Underlying_Types()
    {
        Assert.Same(
            TypeSymbol.String.ClrType,
            PlatformTypeSymbol.Get(TypeSymbol.String).ClrType);
    }

    /// <summary>
    /// ADR-0186 §1 / ADR-0132: the <c>!</c> is positional, and the two
    /// positions mean different types.
    /// <para>
    /// <c>[]!T</c> is a platform slice; <c>[]T!</c> is a slice of platform
    /// elements. An implementation that simply appended <c>!</c> to the
    /// underlying type's name would render <b>both</b> as <c>[]T!</c> and make
    /// them indistinguishable in every diagnostic — which is exactly the defect
    /// ADR-0132 fixed for <c>?</c>, and which does not fall out for <c>!</c>
    /// for free.
    /// </para>
    /// </summary>
    [Fact]
    public void Display_Binds_The_Marker_Positionally_For_Arrays_And_Slices()
    {
        var platformSlice = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.Int32));
        var sliceOfPlatform = SliceTypeSymbol.Get(PlatformTypeSymbol.Get(TypeSymbol.String));

        Assert.Equal("[]!int32", platformSlice.Name);
        Assert.Equal("[]!int32", SymbolDisplay.ToTypeDisplayString(platformSlice));

        Assert.Equal("[]string!", SymbolDisplay.ToTypeDisplayString(sliceOfPlatform));
        Assert.NotEqual(
            SymbolDisplay.ToTypeDisplayString(platformSlice),
            SymbolDisplay.ToTypeDisplayString(sliceOfPlatform));

        var platformArray = PlatformTypeSymbol.Get(ArrayTypeSymbol.Get(TypeSymbol.Int32, 3));
        Assert.Equal("[3]!int32", platformArray.Name);
        Assert.Equal("[3]!int32", SymbolDisplay.ToTypeDisplayString(platformArray));

        var platformRectangular = PlatformTypeSymbol.Get(
            RectangularArrayTypeSymbol.Get(TypeSymbol.Int32, 2));
        Assert.Equal("[,]!int32", platformRectangular.Name);
        Assert.Equal("[,]!int32", SymbolDisplay.ToTypeDisplayString(platformRectangular));
    }

    /// <summary>
    /// Issue #2160's rule, applied to <c>!</c>: the marker must bind to the
    /// whole arrow shape, never to the return type alone.
    /// </summary>
    [Fact]
    public void Display_Parenthesises_A_Platform_Function_Type()
    {
        var function = FunctionTypeSymbol.Get(
            ImmutableArray.Create(TypeSymbol.Int32),
            TypeSymbol.Void);
        var platform = PlatformTypeSymbol.Get(function);

        Assert.Equal($"({function.Name})!", platform.Name);
        Assert.StartsWith("(", SymbolDisplay.ToTypeDisplayString(platform));
        Assert.EndsWith(")!", SymbolDisplay.ToTypeDisplayString(platform));
    }

    /// <summary>
    /// The plain case, and the one hover shows most: <c>string!</c>.
    /// </summary>
    [Fact]
    public void Display_Trails_The_Marker_For_An_Ordinary_Type()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);
        Assert.Equal("string!", platform.Name);
        Assert.Equal("string!", SymbolDisplay.ToTypeDisplayString(platform));
    }

    /// <summary>
    /// ADR-0186 §1: <c>T!</c> must be a wrapper to the canonical structural
    /// walk, not a leaf. Issue #1790 centralised that walk precisely because a
    /// wrapper kind missing from it falls through as "no inner type" and
    /// silently aliases across compilations.
    /// </summary>
    [Fact]
    public void The_Wrapper_Participates_In_The_Canonical_Structural_Walk()
    {
        var parameter = TypeParameter();
        var platform = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(parameter));

        Assert.True(TypeSymbol.ContainsTypeParameter(platform));

        var sink = new System.Collections.Generic.List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(platform, sink);
        Assert.Same(parameter, Assert.Single(sink));
    }

    /// <summary>
    /// The <b>writer</b> half of the same walk, and the half that fails worse.
    /// <para>
    /// The readers above and <c>TrySubstituteCompositeType</c> are two sides of
    /// one contract: what <see cref="TypeSymbol.GetWrappedTypes"/> can see
    /// inside, substitution must be able to rebuild. A wrapper present in the
    /// readers and absent from the writer is not a missed answer but a
    /// <em>wrong</em> one — the readers report that a <c>T!</c> over a type
    /// parameter contains one, the writer answers "not a composite shape", and
    /// the caller keeps the unsubstituted type. That is issue #1790's own bug
    /// class, which is why ADR-0186 touches these walkers at all.
    /// </para>
    /// </summary>
    [Fact]
    public void The_Wrapper_Is_Rebuilt_By_The_Canonical_Substitution()
    {
        var parameter = TypeParameter();

        // `[]T!` — the platform wrapper outermost.
        var platformSlice = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(parameter));
        Assert.True(TypeSymbol.TrySubstituteCompositeType(
            platformSlice,
            inner => SubstituteRecursively(inner, parameter, TypeSymbol.Int32),
            out var substituted));
        var rebuilt = Assert.IsType<PlatformTypeSymbol>(substituted);
        var rebuiltSlice = Assert.IsType<SliceTypeSymbol>(rebuilt.UnderlyingType);
        Assert.Same(TypeSymbol.Int32, rebuiltSlice.ElementType);

        // `[]T!` with the wrapper nested one level down, so it is reached
        // through the recursion rather than at the root.
        var sliceOfPlatform = SliceTypeSymbol.Get(PlatformTypeSymbol.Get(parameter));
        Assert.True(TypeSymbol.TrySubstituteCompositeType(
            sliceOfPlatform,
            inner => SubstituteRecursively(inner, parameter, TypeSymbol.Int32),
            out var nested));
        var nestedSlice = Assert.IsType<SliceTypeSymbol>(nested);
        Assert.Same(
            PlatformTypeSymbol.Get(TypeSymbol.Int32),
            Assert.IsType<PlatformTypeSymbol>(nestedSlice.ElementType));

        // An identity substitution must return the very same symbol, not an
        // equal copy — the cache is what makes `T!` one type.
        Assert.True(TypeSymbol.TrySubstituteCompositeType(
            platformSlice,
            static t => t,
            out var unchanged));
        Assert.Same(platformSlice, unchanged);
    }

    /// <summary>
    /// ADR-0186 §1: <c>T!</c> carries reference-nullability information with no
    /// distinct runtime <c>Type</c>, so it must both (a) count as such an
    /// annotation for gates that decide whether reflection can re-derive a
    /// type, and (b) be stripped by the comparison that comes to a runtime
    /// signature <em>ignoring</em> reference nullability. Those two are the
    /// same fact read in opposite directions, and getting either wrong makes
    /// <c>string!</c> and <c>string</c> differ where they must not.
    /// </summary>
    [Fact]
    public void The_Wrapper_Is_Reference_Nullability_Only()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        Assert.True(TypeSymbol.ContainsReferenceNullableAnnotation(platform));
        Assert.True(TypeSymbol.ContainsReferenceNullableAnnotation(
            SliceTypeSymbol.Get(platform)));

        Assert.True(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
            platform,
            TypeSymbol.String));
        Assert.True(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
            platform,
            NullableTypeSymbol.Get(TypeSymbol.String)));

        // …but it is still not the same runtime signature as an unrelated type.
        Assert.False(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
            platform,
            TypeSymbol.Object));
    }

    /// <summary>
    /// ADR-0186 §8's third round-trip value: a platform position is emitted as
    /// the <b>oblivious</b> byte <c>0</c>, never as <c>1</c>.
    /// <para>
    /// This replaces step 1's
    /// <c>Emit_Refuses_A_Platform_Type_Rather_Than_Encoding_It_As_NonNull</c>,
    /// which pinned a <c>NotSupportedException</c>. That refusal was
    /// right while <c>PlatformTypeSymbol</c> could not reach the emitter and
    /// the only alternative was <c>Append</c>'s fall-through to
    /// <c>AppendClrType</c>. It stopped being right at step 3: an inferred
    /// local whose initializer is an oblivious CLR call has type <c>T!</c>,
    /// and the moment it is captured into a closure display class, an async
    /// state machine or a script result slot, its type is written to metadata
    /// as a synthesized member's signature — ordinary default-on source, not
    /// §9 territory.
    /// </para>
    /// <para>
    /// <b>The constraint that did not move is the important half</b>: byte
    /// <c>1</c> would launder an unknown into a guarantee in metadata, where
    /// the next reader has no way to tell. §8 offers two legal shapes for an
    /// oblivious declaration and says both "read back as <c>T!</c>"; this is
    /// the per-position byte of the second.
    /// </para>
    /// </summary>
    [Fact]
    public void Emit_Encodes_A_Platform_Type_As_The_Oblivious_Byte()
    {
        var platform = PlatformTypeSymbol.Get(TypeSymbol.String);

        Assert.Equal(
            new byte[] { 0 },
            NullableFlagsBuilder.Build(platform).ToArray());

        // …and nested, where a fall-through would be quietest of all. Both
        // positions are asserted because ADR-0132 binds the marker
        // POSITIONALLY: `[]string!` (a non-null slice of platform elements)
        // and `[]!string` (a platform slice of non-null elements) are
        // different types and must not encode to the same bytes.
        Assert.Equal(
            new byte[] { 1, 0 },
            NullableFlagsBuilder.Build(SliceTypeSymbol.Get(platform)).ToArray());
        Assert.Equal(
            new byte[] { 0, 1 },
            NullableFlagsBuilder.Build(
                PlatformTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.String))).ToArray());

        // The negative control: the shapes this builder already handled are
        // untouched, so this is a new arm and not a changed rule.
        Assert.Equal(
            new byte[] { 2 },
            NullableFlagsBuilder.Build(NullableTypeSymbol.Get(TypeSymbol.String)).ToArray());
        Assert.Equal(
            new byte[] { 1 },
            NullableFlagsBuilder.Build(TypeSymbol.String).ToArray());
    }

    /// <summary>
    /// ADR-0186 §8's round-trip guarantee, made <b>total</b>: non-null stays
    /// non-null, nullable stays nullable, <b>oblivious stays oblivious</b>.
    /// <para>
    /// The emit half alone proves nothing — a byte is only correct if the
    /// reader gives it back. This asserts the composition
    /// <c>NullableFlagsBuilder.Build</c> → <c>ClrNullability.ClassifyPosition</c>
    /// → <c>SymbolForState</c> for all three states, in both modes, off the
    /// same emitted bytes. Under ADR-0136 the third case was not expressible
    /// at all; an oblivious G# declaration had to be emitted as something it
    /// was not.
    /// </para>
    /// <para>
    /// The mode-off arm is the one that shows the encoding is not a
    /// platform-types-only convention: byte <c>0</c> is what ADR-0136 already
    /// read as "not non-null", so an assembly emitted by a platform-types
    /// compilation stays readable by an <c>Enabled</c> one — it simply reads
    /// <c>T?</c> there, which is ADR-0136's answer for the same declaration.
    /// </para>
    /// </summary>
    [Fact]
    public void Emit_And_Read_RoundTrip_All_Three_States()
    {
        var cases = new (TypeSymbol Emitted, byte Expected)[]
        {
            (TypeSymbol.String, (byte)1),
            (NullableTypeSymbol.Get(TypeSymbol.String), (byte)2),
            (PlatformTypeSymbol.Get(TypeSymbol.String), (byte)0),
        };

        foreach (var (emitted, expectedByte) in cases)
        {
            var flags = NullableFlagsBuilder.Build(emitted);
            Assert.Equal(new[] { expectedByte }, flags.ToArray());
        }

        using (NullabilityOptions.Enter(NullabilityMode.PlatformTypes))
        {
            Assert.Equal(
                ClrNullabilityState.NotAnnotated,
                ClrNullability.ClassifyPosition(ImmutableArray.Create((byte)1), 0));
            Assert.Equal(
                ClrNullabilityState.Annotated,
                ClrNullability.ClassifyPosition(ImmutableArray.Create((byte)2), 0));
            Assert.Equal(
                ClrNullabilityState.Oblivious,
                ClrNullability.ClassifyPosition(ImmutableArray.Create((byte)0), 0));

            Assert.IsType<PlatformTypeSymbol>(
                ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious));
        }

        // Mode off: the very same emitted byte still reads as "not non-null",
        // which is ADR-0136's answer. The encoding is forward-compatible in
        // both directions rather than a private convention.
        Assert.IsType<NullableTypeSymbol>(
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious));
    }

    /// <summary>
    /// The recursive substitution callback shape every real caller of
    /// <c>TrySubstituteCompositeType</c> passes: replace the leaf, else let the
    /// canonical walk rebuild the composite around a recursive call.
    /// </summary>
    /// <param name="type">The type to substitute in.</param>
    /// <param name="from">The type parameter to replace.</param>
    /// <param name="to">Its replacement.</param>
    /// <returns>The substituted type.</returns>
    private static TypeSymbol SubstituteRecursively(
        TypeSymbol type,
        TypeParameterSymbol from,
        TypeSymbol to)
    {
        if (ReferenceEquals(type, from))
        {
            return to;
        }

        return TypeSymbol.TrySubstituteCompositeType(
            type,
            inner => SubstituteRecursively(inner, from, to),
            out var result)
            ? result
            : type;
    }

    private static TypeParameterSymbol TypeParameter()
        => new TypeParameterSymbol(
            "T",
            ordinal: 0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
}
