// <copyright file="ClrNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
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
        Assert.Same(TypeSymbol.Int, nullable.UnderlyingType);
    }

    [Fact]
    public void NonNullableValueType_StaysFlat()
    {
        var sym = TypeSymbol.FromClrType(typeof(int));
        Assert.Same(TypeSymbol.Int, sym);
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
    public void NonAnnotated_List_NoInnerFlags_StaysFlat()
    {
        // A method with no nullable annotation and no NullableContext → no annotation
        var method = typeof(ObliviousContainer).GetMethod(nameof(ObliviousContainer.GetList));
        var sym = ClrNullability.GetReturnTypeSymbol(method!);

        // No NullabilityAnnotatedTypeSymbol when there are no nullable flags at all,
        // or when the context implies oblivious (flag == 0).
        // With #nullable disable the compiler emits no [NullableContext] → flat symbol.
        Assert.IsNotType<NullabilityAnnotatedTypeSymbol>(sym);
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

#pragma warning disable CS8632 // The annotation for nullable reference types should only be used in code within a '#nullable' annotations context.
#pragma warning disable SA1649 // File name should match first type name
#pragma warning disable SA1402 // File may only contain a single type
#pragma warning disable CS8601 // Possible null reference assignment
    /// <summary>Simulates a pre-nullable-annotation (oblivious) type.</summary>
    public class ObliviousContainer
    {
        // No #nullable context here — compiler emits no NullableContextAttribute.
#pragma warning disable CS8603
        public List<string> GetList() => null;
#pragma warning restore CS8603
    }
#pragma warning restore CS8632
#pragma warning restore SA1649
#pragma warning restore SA1402
#pragma warning restore CS8601
}

