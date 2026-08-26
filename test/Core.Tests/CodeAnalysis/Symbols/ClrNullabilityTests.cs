// <copyright file="ClrNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Phase 3.C.5 / ADR-0001 / issue #209: BCL nullable interop.
///
/// Covers value-type lift (<c>Nullable&lt;T&gt;</c> on the CLR side becomes
/// <see cref="NullableTypeSymbol"/> on the GSharp side) and reference-type
/// surfacing via <c>[NullableContext]</c> / <c>[Nullable]</c> attributes,
/// including inner-position generic-type-argument nullability.
/// </summary>
public class ClrNullabilityTests
{
    [Fact]
    public void NullableValueType_LiftsToNullableTypeSymbol()
    {
        var sym = TypeSymbol.FromClrType(typeof(int?));
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.Int32, nullable.UnderlyingType);
    }

    [Fact]
    public void NonNullableValueType_StaysFlat()
    {
        var sym = TypeSymbol.FromClrType(typeof(int));
        Assert.Same(TypeSymbol.Int32, sym);
        Assert.IsNotType<NullableTypeSymbol>(sym);
    }

    [Fact]
    public void ReferenceTypeAnnotation_SurfacesAsNullable()
    {
        // Sample.AnnotatedReturn is annotated `string?` so the binder should
        // see NullableTypeSymbol(String).
        var method = typeof(Sample).GetMethod(nameof(Sample.AnnotatedReturn));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void ReferenceTypeNonNullAnnotation_StaysFlat()
    {
        var method = typeof(Sample).GetMethod(nameof(Sample.NonNullReturn));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);
        Assert.Same(TypeSymbol.String, sym);
    }

    // -----------------------------------------------------------------------
    // Issue #209: inner-position (generic type argument) nullability
    // -----------------------------------------------------------------------

    [Fact]
    public void Dictionary_ValueAnnotatedNullable_SurfacesInnerNullability()
    {
        // Sample.GetDictionary returns Dictionary<string, string?>.
        // The NullableAttribute byte array is {1, 1, 2}:
        //   [0] = 1 → Dictionary itself is non-null
        //   [1] = 1 → string key is non-null
        //   [2] = 2 → string? value is nullable
        var method = typeof(Sample).GetMethod(nameof(Sample.GetDictionary));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);

        // Top level: Dictionary is non-nullable → NullabilityAnnotatedTypeSymbol (not NullableTypeSymbol)
        var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);
        Assert.Equal(typeof(Dictionary<string, string>), annotated.ClrType);

        // Key type (arg 0): string — non-nullable
        var keyType = annotated.GetTypeArgumentSymbol(0);
        Assert.Same(TypeSymbol.String, keyType);
        Assert.IsNotType<NullableTypeSymbol>(keyType);

        // Value type (arg 1): string? — nullable
        var valueType = annotated.GetTypeArgumentSymbol(1);
        var nullableValue = Assert.IsType<NullableTypeSymbol>(valueType);
        Assert.Same(TypeSymbol.String, nullableValue.UnderlyingType);
    }

    [Fact]
    public void Dictionary_ValueAnnotatedNullable_GetTypeArgumentSymbolForClrType_Works()
    {
        var method = typeof(Sample).GetMethod(nameof(Sample.GetDictionary));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);
        var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);

        // Lookup by CLR type: string key
        var keyType = annotated.GetTypeArgumentSymbolForClrType(typeof(string));

        // The first string arg (key) is non-nullable.
        Assert.Same(TypeSymbol.String, keyType);
        Assert.IsNotType<NullableTypeSymbol>(keyType);
    }

    [Fact]
    public void List_ElementAnnotatedNullable_SurfacesInnerNullability()
    {
        // Sample.GetList returns List<string?>.
        // NullableAttribute byte array: {1, 2}
        //   [0] = 1 → List is non-null
        //   [1] = 2 → string? element is nullable
        var method = typeof(Sample).GetMethod(nameof(Sample.GetList));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);

        var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);
        Assert.Equal(typeof(List<string>), annotated.ClrType);

        // Element type (arg 0): string? — nullable
        var elemType = annotated.GetTypeArgumentSymbol(0);
        var nullableElem = Assert.IsType<NullableTypeSymbol>(elemType);
        Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType);
    }

    [Fact]
    public void List_ElementAnnotatedNullable_GetTypeArgumentSymbolForClrType_Works()
    {
        var method = typeof(Sample).GetMethod(nameof(Sample.GetList));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);
        var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);

        var elemType = annotated.GetTypeArgumentSymbolForClrType(typeof(string));
        var nullableElem = Assert.IsType<NullableTypeSymbol>(elemType);
        Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType);
    }

    [Fact]
    public void List_ElementAnnotatedNullable_OpenIndexerParameterMapsByPosition()
    {
        var method = typeof(Sample).GetMethod(nameof(Sample.GetList));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);
        var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);
        var openElement = typeof(List<>).GetGenericArguments()[0];

        var elemType = annotated.GetTypeArgumentSymbolForClrType(openElement);

        var nullableElem = Assert.IsType<NullableTypeSymbol>(elemType);
        Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType);
    }

    [Fact]
    public void FuncParameter_WithNullableFirstArg_SurfacesInnerNullability()
    {
        // Sample.AcceptFunc takes a Func<string?, int> parameter.
        // NullableAttribute byte array on that parameter: {1, 2}
        //   [0] = 1 → Func is non-null
        //   [1] = 2 → string? first arg is nullable
        // (int is a value type — contributes no byte)
        var method = typeof(Sample).GetMethod(nameof(Sample.AcceptFunc));
        var parameter = method!.GetParameters()[0];
        var sym = ClrNullability.GetParameterTypeSymbol(parameter);

        var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);
        Assert.Equal(typeof(Func<string, int>), annotated.ClrType);

        // First type argument (string?): nullable
        var arg0 = annotated.GetTypeArgumentSymbol(0);
        var nullableArg = Assert.IsType<NullableTypeSymbol>(arg0);
        Assert.Same(TypeSymbol.String, nullableArg.UnderlyingType);
    }

    [Fact]
    public void CountNullabilityBytes_SimpleRefType_Returns1()
    {
        Assert.Equal(1, ClrNullability.CountNullabilityBytes(typeof(string)));
    }

    [Fact]
    public void CountNullabilityBytes_ValueType_Returns0()
    {
        Assert.Equal(0, ClrNullability.CountNullabilityBytes(typeof(int)));
    }

    [Fact]
    public void CountNullabilityBytes_GenericRefType_IncludesArgs()
    {
        // Dictionary<string, string>: 1 (Dict) + 1 (string key) + 1 (string value) = 3
        Assert.Equal(3, ClrNullability.CountNullabilityBytes(typeof(Dictionary<string, string>)));
    }

    [Fact]
    public void CountNullabilityBytes_GenericMixedArgs_SkipsValueType()
    {
        // Dictionary<int, string>: 1 (Dict) + 0 (int key) + 1 (string value) = 2
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(typeof(Dictionary<int, string>)));
    }

    [Fact]
    public void CountNullabilityBytes_GenericValueType_IncludesLeadingPlaceholder()
    {
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(typeof(ValueTuple<string>)));
        Assert.Equal(
            4,
            ClrNullability.CountNullabilityBytes(
                typeof(Dictionary<ValueTuple<string>, object>)));
    }

    [Fact]
    public void NullableValueTuple_IsMetadataTransparentAndKeepsInnerAnnotations()
    {
        var clrType = typeof(Nullable<ValueTuple<object, string>>);
        var flags = ImmutableArray.Create<byte>(0, 1, 2);

        Assert.Equal(3, ClrNullability.CountNullabilityBytes(clrType));
        var nullable = Assert.IsType<NullableTypeSymbol>(
            ClrNullability.SymbolFromFlagsOffset(clrType, flags, 0));
        var tuple = Assert.IsType<TupleTypeSymbol>(nullable.UnderlyingType);
        Assert.Same(TypeSymbol.Object, tuple.ElementTypes[0]);
        var nullableText = Assert.IsType<NullableTypeSymbol>(tuple.ElementTypes[1]);
        Assert.Same(TypeSymbol.String, nullableText.UnderlyingType);
        Assert.Equal(flags.ToArray(), NullableFlagsBuilder.Build(nullable).ToArray());
    }

    [Fact]
    public void NullableGenericValueArgument_DoesNotShiftFollowingSibling()
    {
        var clrType = typeof(PairContainer<KeyValuePair<string, object>?, string>);
        var flags = ImmutableArray.Create<byte>(1, 0, 2, 1, 1);

        Assert.Equal(5, ClrNullability.CountNullabilityBytes(clrType));
        var container = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.SymbolFromFlagsOffset(clrType, flags, 0));
        var nullablePair = Assert.IsType<NullableTypeSymbol>(
            container.GetTypeArgumentSymbol(0));
        var pair = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            nullablePair.UnderlyingType);
        var nullableKey = Assert.IsType<NullableTypeSymbol>(
            pair.GetTypeArgumentSymbol(0));
        Assert.Same(TypeSymbol.String, nullableKey.UnderlyingType);
        Assert.Same(TypeSymbol.Object, pair.GetTypeArgumentSymbol(1));
        Assert.Same(TypeSymbol.String, container.GetTypeArgumentSymbol(1));
        Assert.Equal(flags.ToArray(), NullableFlagsBuilder.Build(container).ToArray());
    }

    [Fact]
    public void StructConstrainedGenericParameter_ConsumesObliviousSlot()
    {
        var pairMethod = typeof(Sample).GetMethod(nameof(Sample.MakeStructPair));
        Assert.NotNull(pairMethod);
        var pairFlags = ClrNullability.ReadNullableFlags(
            pairMethod.ReturnParameter,
            pairMethod);
        Assert.Equal(new byte[] { 1, 0, 2 }, pairFlags.ToArray());
        Assert.Equal(3, ClrNullability.CountNullabilityBytes(pairMethod.ReturnType));

        var pair = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(pairMethod));
        Assert.IsNotType<NullableTypeSymbol>(pair.GetTypeArgumentSymbol(0));
        Assert.IsType<NullableTypeSymbol>(pair.GetTypeArgumentSymbol(1));
        Assert.Equal(pairFlags.ToArray(), NullableFlagsBuilder.Build(pair).ToArray());

        var valueMethod = typeof(Sample).GetMethod(nameof(Sample.MakeStructValue));
        Assert.NotNull(valueMethod);
        var valueFlags = ClrNullability.ReadNullableFlags(
            valueMethod.ReturnParameter,
            valueMethod);
        Assert.Equal(new byte[] { 0 }, valueFlags.ToArray());
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(valueMethod.ReturnType));
        Assert.Equal(
            new byte[] { 0, 0 },
            ClrNullability.ExpandNullableFlags(
                valueMethod.ReturnType,
                valueFlags).ToArray());

        var value = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(valueMethod));
        Assert.IsNotType<NullableTypeSymbol>(value.GetTypeArgumentSymbol(0));
        Assert.Equal(valueFlags.ToArray(), NullableFlagsBuilder.Build(value).ToArray());
    }

    [Fact]
    public void SymbolicStructConstraint_EmitsPairAndValueOuterSlots()
    {
        var parameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None)
        {
            HasValueTypeConstraint = true,
        };
        var pair = ImportedTypeSymbol.GetConstructed(
            typeof(PairContainer<int, string>),
            typeof(PairContainer<,>),
            ImmutableArray.Create<TypeSymbol>(
                parameter,
                NullableTypeSymbol.Get(TypeSymbol.String)));
        var value = ImportedTypeSymbol.GetConstructed(
            typeof(ValueContainer<int>),
            typeof(ValueContainer<>),
            ImmutableArray.Create<TypeSymbol>(parameter));

        Assert.Equal(
            new byte[] { 1, 0, 2 },
            NullableFlagsBuilder.Build(pair).ToArray());
        Assert.Equal(
            new byte[] { 0, 0 },
            NullableFlagsBuilder.Build(value).ToArray());
    }

    [Fact]
    public void RectangularArray_NullableElementAndOuterAnnotations_RoundTrip()
    {
        var nonNullMethod = typeof(Sample).GetMethod(nameof(Sample.GetNullableElementGrid));
        // nameof targets a declared Sample method, establishing reflection lookup success.
        var nonNullSymbol = Assert.IsType<RectangularArrayTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(nonNullMethod!));
        Assert.Equal(2, nonNullSymbol.Rank);
        var nullableElement = Assert.IsType<NullableTypeSymbol>(nonNullSymbol.ElementType);
        Assert.Same(TypeSymbol.String, nullableElement.UnderlyingType);

        var nullableMethod = typeof(Sample).GetMethod(nameof(Sample.GetNullableGrid));
        // nameof targets a declared Sample method, establishing reflection lookup success.
        var nullableOuter = Assert.IsType<NullableTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(nullableMethod!));
        var nullableGrid = Assert.IsType<RectangularArrayTypeSymbol>(nullableOuter.UnderlyingType);
        Assert.Equal(2, nullableGrid.Rank);
        nullableElement = Assert.IsType<NullableTypeSymbol>(nullableGrid.ElementType);
        Assert.Same(TypeSymbol.String, nullableElement.UnderlyingType);
    }

    [Fact]
    public void CountNullabilityBytes_RectangularArray_IncludesElement()
    {
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(typeof(string[,])));
        Assert.Equal(1, ClrNullability.CountNullabilityBytes(typeof(int[,,])));
    }

    [Fact]
    public void Oblivious_Reference_NoAnnotation_SurfacesAsNullable()
    {
        // Issue #1354: a genuinely oblivious (pre-nullable, `#nullable disable`)
        // imported reference type carries no [Nullable]/[NullableContext] anywhere.
        // Post-#1354 the Kotlin "unannotated/platform type is nullable" rule makes
        // the binder surface it as NullableTypeSymbol (was: flat non-null pre-#1354).
        var method = typeof(ObliviousContainer).GetMethod(nameof(ObliviousContainer.GetString));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);

        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void Oblivious_List_NoInnerFlags_SurfacesAsNullable()
    {
        // A method with no nullable annotation and no NullableContext at all.
        // Post-#1354 the outer List<string> reference position is nullable.
        // There are no inner per-position bytes, so the symbol is a plain
        // NullableTypeSymbol (not a NullabilityAnnotatedTypeSymbol).
        var method = typeof(ObliviousContainer).GetMethod(nameof(ObliviousContainer.GetList));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);

        Assert.IsNotType<NullabilityAnnotatedTypeSymbol>(sym);
        Assert.IsType<NullableTypeSymbol>(sym);
    }

    // -----------------------------------------------------------------------
    // Issue #1354: direct exercise of the import reading rule + scalar/context
    // expansion via SymbolFromFlagsOffset / IsPositionNonNull.
    // -----------------------------------------------------------------------

    [Fact]
    public void IsPositionNonNull_EmptyFlags_IsNullable()
    {
        // No annotation and no context anywhere → nullable by default.
        Assert.False(ClrNullability.IsPositionNonNull(ImmutableArray<byte>.Empty, 0));
        Assert.False(ClrNullability.IsPositionNonNull(ImmutableArray<byte>.Empty, 3));
    }

    [Fact]
    public void IsPositionNonNull_Scalar1_AppliesNonNullToEveryPosition()
    {
        // A single context/scalar byte of 1 (NotAnnotated) makes ALL positions non-null.
        var flags = ImmutableArray.Create<byte>(1);
        Assert.True(ClrNullability.IsPositionNonNull(flags, 0));
        Assert.True(ClrNullability.IsPositionNonNull(flags, 1));
        Assert.True(ClrNullability.IsPositionNonNull(flags, 5));
    }

    [Fact]
    public void IsPositionNonNull_Scalar2_AppliesNullableToEveryPosition()
    {
        // A single scalar byte of 2 (Annotated) makes ALL positions nullable.
        var flags = ImmutableArray.Create<byte>(2);
        Assert.False(ClrNullability.IsPositionNonNull(flags, 0));
        Assert.False(ClrNullability.IsPositionNonNull(flags, 2));
    }

    [Fact]
    public void IsPositionNonNull_PerPosition_OnlyExplicitOneIsNonNull()
    {
        // Per-position array: non-null iff that exact byte is 1.
        var flags = ImmutableArray.Create<byte>(1, 2, 0);
        Assert.True(ClrNullability.IsPositionNonNull(flags, 0));   // 1 → non-null
        Assert.False(ClrNullability.IsPositionNonNull(flags, 1));  // 2 → nullable
        Assert.False(ClrNullability.IsPositionNonNull(flags, 2));  // 0 oblivious → nullable
        Assert.False(ClrNullability.IsPositionNonNull(flags, 9));  // beyond length → nullable
    }

    [Fact]
    public void SymbolFromFlagsOffset_Scalar1_NonNullAtEveryOffset()
    {
        // A 1-element [Nullable(1)] / [NullableContext(1)] applies to every
        // position: a reference type at ANY offset reads as non-null.
        var flags = ImmutableArray.Create<byte>(1);
        var sym0 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 0);
        var sym3 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 3);

        Assert.Same(TypeSymbol.String, sym0);
        Assert.IsNotType<NullableTypeSymbol>(sym0);
        Assert.Same(TypeSymbol.String, sym3);
        Assert.IsNotType<NullableTypeSymbol>(sym3);
    }

    [Fact]
    public void SymbolFromFlagsOffset_Scalar2_NullableAtEveryOffset()
    {
        // A 1-element [Nullable(2)] applies to every position: a reference type
        // at ANY offset reads as nullable.
        var flags = ImmutableArray.Create<byte>(2);
        var sym0 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 0);
        var sym5 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 5);

        Assert.IsType<NullableTypeSymbol>(sym0);
        Assert.IsType<NullableTypeSymbol>(sym5);
    }

    [Fact]
    public void SymbolFromFlagsOffset_Scalar1_OverGeneric_OuterNonNull()
    {
        // [Nullable(1)] over List<string>: the outer List is non-null (and inner
        // positions default to non-null via the per-offset scalar rule).
        var flags = ImmutableArray.Create<byte>(1);
        var sym = ClrNullability.SymbolFromFlagsOffset(typeof(List<string>), flags, 0);

        Assert.IsNotType<NullableTypeSymbol>(sym);
        Assert.Equal(typeof(List<string>), sym.ClrType);
    }

    [Fact]
    public void SymbolFromFlagsOffset_Scalar2_OverGeneric_OuterNullable()
    {
        // [Nullable(2)] over List<string>: the outer List is nullable.
        var flags = ImmutableArray.Create<byte>(2);
        var sym = ClrNullability.SymbolFromFlagsOffset(typeof(List<string>), flags, 0);

        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Equal(typeof(List<string>), nullable.UnderlyingType.ClrType);
    }

    [Fact]
    public void SymbolFromFlagsOffset_EmptyFlags_RefType_IsNullable()
    {
        var sym = ClrNullability.SymbolFromFlagsOffset(typeof(string), ImmutableArray<byte>.Empty, 0);
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Theory]
    [InlineData(null)]
    [InlineData((byte)2)]
    public void SzArray_NullableScalarOrAbsentFlags_PropagateToElement(byte? scalar)
    {
        var flags = scalar.HasValue
            ? ImmutableArray.Create(scalar.Value)
            : ImmutableArray<byte>.Empty;
        var symbol = Assert.IsType<NullableTypeSymbol>(
            ClrNullability.SymbolFromFlagsOffset(typeof(string[]), flags, 0));
        var array = Assert.IsType<NullabilityAnnotatedTypeSymbol>(symbol.UnderlyingType);
        var element = Assert.IsType<NullableTypeSymbol>(
            array.GetTypeArgumentSymbolForClrType(typeof(string)));
        Assert.Same(TypeSymbol.String, element.UnderlyingType);
    }

    [Fact]
    public void GenericValueTypePlaceholder_KeepsFollowingSiblingNonNull()
    {
        var flags = ImmutableArray.Create<byte>(1, 0, 2, 1);
        var dictionary = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.SymbolFromFlagsOffset(
                typeof(Dictionary<ValueTuple<string>, object>),
                flags,
                0));
        var tuple = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            dictionary.GetTypeArgumentSymbol(0));
        var nullableItem = Assert.IsType<NullableTypeSymbol>(tuple.GetTypeArgumentSymbol(0));

        Assert.Same(TypeSymbol.String, nullableItem.UnderlyingType);
        Assert.Same(TypeSymbol.Object, dictionary.GetTypeArgumentSymbol(1));
        Assert.Equal(flags.ToArray(), NullableFlagsBuilder.Build(dictionary).ToArray());
    }

    [Fact]
    public void NullableOuterAnnotatedArrayAndGeneric_ReemitInnerFlags()
    {
        Assert.Equal(
            new byte[] { 2, 1 },
            ReemitNullableOuter(typeof(string[]), ImmutableArray.Create<byte>(1, 1)).ToArray());
        Assert.Equal(
            new byte[] { 2, 1 },
            ReemitNullableOuter(typeof(List<string>), ImmutableArray.Create<byte>(1, 1)).ToArray());
        Assert.Equal(
            new byte[] { 2 },
            ReemitNullableOuter(typeof(string[]), ImmutableArray.Create<byte>(2)).ToArray());
        Assert.Equal(
            new byte[] { 2 },
            ReemitNullableOuter(typeof(List<string>), ImmutableArray<byte>.Empty).ToArray());
        Assert.Equal(
            new byte[] { 2, 0, 2, 2 },
            ReemitNullableOuter(
                typeof(Dictionary<ValueTuple<string>, object>),
                ImmutableArray.Create<byte>(2)).ToArray());

        static ImmutableArray<byte> ReemitNullableOuter(
            Type clrType,
            ImmutableArray<byte> flags)
        {
            var annotated = new NullabilityAnnotatedTypeSymbol(
                TypeSymbol.FromClrType(clrType),
                flags);
            return NullableFlagsBuilder.Build(NullableTypeSymbol.Get(annotated));
        }
    }

    [Fact]
    public void NestedScalarAnnotatedGeneric_ExpandsBeforeFollowingTupleElement()
    {
        var annotatedList = new NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof(List<string>)),
            ImmutableArray.Create<byte>(2));
        var tuple = TupleTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(
            NullableTypeSymbol.Get(annotatedList),
            TypeSymbol.String));
        var expected = new byte[] { 0, 2, 2, 1 };

        Assert.Equal(expected, NullableFlagsBuilder.Build(tuple).ToArray());
        var decoded = Assert.IsType<TupleTypeSymbol>(
            ClrNullability.SymbolFromFlagsOffset(
            typeof(ValueTuple<List<string>, string>),
            expected.ToImmutableArray(),
            0));
        var nullableList = Assert.IsType<NullableTypeSymbol>(decoded.ElementTypes[0]);
        var decodedList = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            nullableList.UnderlyingType);
        var nullableItem = Assert.IsType<NullableTypeSymbol>(
            decodedList.GetTypeArgumentSymbol(0));
        Assert.Same(TypeSymbol.String, nullableItem.UnderlyingType);
        Assert.Same(TypeSymbol.String, decoded.ElementTypes[1]);
    }

    [Fact]
    public void FlattenedLongTuples_EmitEveryPhysicalRestPlaceholder()
    {
        AssertTuple(
            8,
            new byte[] { 0, 2, 1, 1, 1, 1, 1, 1, 0, 2 });
        AssertTuple(
            15,
            new byte[] { 0, 2, 1, 1, 1, 1, 1, 1, 0, 2, 1, 1, 1, 1, 1, 1, 0, 2 });

        static void AssertTuple(int arity, byte[] expected)
        {
            var elements = Enumerable.Range(0, arity)
                .Select(index => index is 0 or 7 || index == arity - 1
                    ? (TypeSymbol)NullableTypeSymbol.Get(TypeSymbol.String)
                    : TypeSymbol.String)
                .ToImmutableArray();
            var tuple = TupleTypeSymbol.Get(elements);
            var clrType = Assert.IsAssignableFrom<Type>(
                TupleTypeSymbol.BuildClrType(
                    Enumerable.Repeat(typeof(string), arity).ToArray()));

            Assert.Equal(expected.Length, ClrNullability.CountNullabilityBytes(clrType));
            Assert.Equal(expected, NullableFlagsBuilder.Build(tuple).ToArray());

            var decoded = Assert.IsType<TupleTypeSymbol>(
                ClrNullability.SymbolFromFlagsOffset(
                    clrType,
                    expected.ToImmutableArray(),
                    0));
            Assert.IsType<NullableTypeSymbol>(decoded.ElementTypes[0]);
            Assert.IsType<NullableTypeSymbol>(decoded.ElementTypes[7]);
            Assert.IsType<NullableTypeSymbol>(decoded.ElementTypes[^1]);
            Assert.Same(TypeSymbol.String, decoded.ElementTypes[1]);
            Assert.Same(TypeSymbol.String, decoded.ElementTypes[^2]);
            Assert.False(Conversion.Classify(TypeSymbol.Null, decoded.ElementTypes[1]).Exists);
            Assert.False(Conversion.Classify(TypeSymbol.Null, decoded.ElementTypes[^2]).Exists);
        }
    }

    [Fact]
    public void GetPropertyElementTypeSymbol_AnnotatedNullableProperty_IsNullable()
    {
        // Issue #1701 crack 1: a ref-returning indexer element must keep the
        // declaring property's `[NullableAttribute]` metadata instead of
        // erasing via a raw `TypeSymbol.FromClrType`.
        var prop = typeof(Sample).GetProperty(nameof(Sample.AnnotatedProperty));
        var sym = ClrNullability.GetPropertyElementTypeSymbol(prop!, typeof(string));
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void GetPropertyElementTypeSymbol_NonNullProperty_StaysFlat()
    {
        var prop = typeof(Sample).GetProperty(nameof(Sample.NonNullProperty));
        var sym = ClrNullability.GetPropertyElementTypeSymbol(prop!, typeof(string));
        Assert.Same(TypeSymbol.String, sym);
    }

    public sealed class PairContainer<TFirst, TSecond>
    {
    }

    public struct ValueContainer<T>
    {
    }

    /// <summary>
    /// Carries the C# 8 nullability annotations we need to test against.
    /// Compiled with the surrounding project's nullable context — the
    /// <c>?</c> on <see cref="AnnotatedReturn"/> emits a
    /// <c>[NullableAttribute(2)]</c> on the return parameter and the
    /// non-annotated <see cref="NonNullReturn"/> picks up the
    /// <c>[NullableContextAttribute(1)]</c> from the enclosing type.
    /// </summary>
    public class Sample
    {
        public static PairContainer<T, string?> MakeStructPair<T>()
            where T : struct
        {
            return new PairContainer<T, string?>();
        }

        public static ValueContainer<T> MakeStructValue<T>()
            where T : struct
        {
            return default;
        }

        public string? AnnotatedReturn()
        {
            return null;
        }

        public string NonNullReturn()
        {
            return string.Empty;
        }

        // Issue #1701: stand-ins for a ref-returning indexer's dereferenced
        // element type. A genuine `ref T?` indexer is not exercisable through
        // G# surface syntax today (Span/ReadOnlySpan element T is always
        // value-typed in practice), so these validate the routed helper
        // (`ClrNullability.GetPropertyElementTypeSymbol`) directly: it must
        // read the `[NullableAttribute]` metadata off the declaring property
        // and apply it to the supplied (dereferenced) element type, exactly
        // like `GetPropertyTypeSymbol` does for the non-byref case.
        public string? AnnotatedProperty => null;

        public string NonNullProperty => string.Empty;

        public Dictionary<string, string?> GetDictionary()
        {
            return new Dictionary<string, string?>();
        }

        public List<string?> GetList()
        {
            return new List<string?>();
        }

        public int AcceptFunc(Func<string?, int> f)
        {
            return f(null);
        }

        public string?[,] GetNullableElementGrid()
        {
            return new string?[1, 1];
        }

        public string?[,]? GetNullableGrid()
        {
            return null;
        }
    }

    /// <summary>Simulates a pre-nullable-annotation (oblivious) type.</summary>
#nullable disable
    public class ObliviousContainer
    {
        // Genuinely oblivious: the `#nullable disable` region makes the C#
        // compiler emit NO NullableContextAttribute / NullableAttribute on
        // these members or this type — so the metadata importer finds no
        // nullability information at all (issue #1354: → nullable).
        public List<string> GetList() => null;

        public string GetString() => null;
    }
#nullable restore

}
