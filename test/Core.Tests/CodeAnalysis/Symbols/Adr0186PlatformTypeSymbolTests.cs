// <copyright file="Adr0186PlatformTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
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
/// These tests will need updating — not silently passing — when ADR-0186 step 2
/// teaches conversions and member lookup about <c>T!</c> and step 3 flips the
/// mode on by default.
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
        var parameter = new TypeParameterSymbol(
            "T",
            ordinal: 0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var platform = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(parameter));

        Assert.True(TypeSymbol.ContainsTypeParameter(platform));

        var sink = new System.Collections.Generic.List<TypeParameterSymbol>();
        TypeSymbol.CollectReferencedTypeParameters(platform, sink);
        Assert.Same(parameter, Assert.Single(sink));
    }
}
