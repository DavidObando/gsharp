// <copyright file="PrimitiveTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0044 / ADR-0045: built-in primitive type symbols and their
/// <see cref="TypeSymbol.FromClrType(Type)"/> mapping.
///
/// Phase 1 of issue #142 — confirms each new symbol exists, exposes the
/// correct CLR type, and round-trips through <c>FromClrType</c>.
/// </summary>
public class PrimitiveTypeSymbolTests
{
    public static TheoryData<TypeSymbol, Type, string> PrimitiveTypeData => new()
    {
        { TypeSymbol.Bool, typeof(bool), "bool" },
        { TypeSymbol.Byte, typeof(byte), "byte" },
        { TypeSymbol.SByte, typeof(sbyte), "sbyte" },
        { TypeSymbol.Short, typeof(short), "short" },
        { TypeSymbol.UShort, typeof(ushort), "ushort" },
        { TypeSymbol.Int, typeof(int), "int" },
        { TypeSymbol.UInt, typeof(uint), "uint" },
        { TypeSymbol.Long, typeof(long), "long" },
        { TypeSymbol.ULong, typeof(ulong), "ulong" },
        { TypeSymbol.NInt, typeof(nint), "nint" },
        { TypeSymbol.NUInt, typeof(nuint), "nuint" },
        { TypeSymbol.Float32, typeof(float), "float32" },
        { TypeSymbol.Float64, typeof(double), "float64" },
        { TypeSymbol.Decimal, typeof(decimal), "decimal" },
        { TypeSymbol.Char, typeof(char), "char" },
        { TypeSymbol.String, typeof(string), "string" },
        { TypeSymbol.Object, typeof(object), "object" },
        { TypeSymbol.Void, typeof(void), "void" },
    };

    [Theory]
    [MemberData(nameof(PrimitiveTypeData))]
    public void PrimitiveSymbol_HasCanonicalNameAndClrType(TypeSymbol symbol, Type expectedClrType, string expectedName)
    {
        Assert.Equal(expectedName, symbol.Name);
        Assert.Same(expectedClrType, symbol.ClrType);
    }

    [Theory]
    [MemberData(nameof(PrimitiveTypeData))]
    public void FromClrType_MapsBackToCanonicalSymbol(TypeSymbol symbol, Type clrType, string expectedName)
    {
        _ = expectedName;
        Assert.Same(symbol, TypeSymbol.FromClrType(clrType));
    }

    [Fact]
    public void FromClrType_NullableValueTypes_LiftThroughEachPrimitive()
    {
        // Nullable<T> lifting (ADR-0001) still wraps each new value-type primitive.
        AssertNullableLifts(typeof(byte?), TypeSymbol.Byte);
        AssertNullableLifts(typeof(sbyte?), TypeSymbol.SByte);
        AssertNullableLifts(typeof(short?), TypeSymbol.Short);
        AssertNullableLifts(typeof(ushort?), TypeSymbol.UShort);
        AssertNullableLifts(typeof(uint?), TypeSymbol.UInt);
        AssertNullableLifts(typeof(long?), TypeSymbol.Long);
        AssertNullableLifts(typeof(ulong?), TypeSymbol.ULong);
        AssertNullableLifts(typeof(nint?), TypeSymbol.NInt);
        AssertNullableLifts(typeof(nuint?), TypeSymbol.NUInt);
        AssertNullableLifts(typeof(float?), TypeSymbol.Float32);
        AssertNullableLifts(typeof(double?), TypeSymbol.Float64);
        AssertNullableLifts(typeof(decimal?), TypeSymbol.Decimal);
        AssertNullableLifts(typeof(char?), TypeSymbol.Char);
    }

    private static void AssertNullableLifts(Type nullableClrType, TypeSymbol expectedUnderlying)
    {
        var sym = TypeSymbol.FromClrType(nullableClrType);
        var nullable = Assert.IsType<NullableTypeSymbol>(sym);
        Assert.Same(expectedUnderlying, nullable.UnderlyingType);
    }
}
