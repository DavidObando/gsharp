// <copyright file="ClrNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
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
        public string? AnnotatedReturn()
        {
            return null;
        }

        public string NonNullReturn()
        {
            return string.Empty;
        }

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
