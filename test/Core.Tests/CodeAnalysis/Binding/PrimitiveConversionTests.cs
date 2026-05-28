// <copyright file="PrimitiveConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3 of #142: exercises <see cref="Conversion.Classify"/> across the
/// full ADR-0044 numeric lattice and the ADR-0045 object boxing/unboxing
/// rules. Each test pair pins one cell in the conversion matrix so a
/// future refactor of the table can be caught here rather than via a
/// downstream emitter or interpreter failure.
/// </summary>
public class PrimitiveConversionTests
{
    public static TheoryData<TypeSymbol, TypeSymbol> ImplicitNumericWidenings()
    {
        var data = new TheoryData<TypeSymbol, TypeSymbol>
        {
            { TypeSymbol.Int8, TypeSymbol.Int16 },
            { TypeSymbol.Int8, TypeSymbol.Int32 },
            { TypeSymbol.Int8, TypeSymbol.Int64 },
            { TypeSymbol.Int8, TypeSymbol.Float32 },
            { TypeSymbol.Int8, TypeSymbol.Float64 },
            { TypeSymbol.Int8, TypeSymbol.Decimal },
            { TypeSymbol.UInt8, TypeSymbol.Int16 },
            { TypeSymbol.UInt8, TypeSymbol.UInt16 },
            { TypeSymbol.UInt8, TypeSymbol.Int32 },
            { TypeSymbol.UInt8, TypeSymbol.UInt32 },
            { TypeSymbol.UInt8, TypeSymbol.Int64 },
            { TypeSymbol.UInt8, TypeSymbol.UInt64 },
            { TypeSymbol.UInt8, TypeSymbol.Decimal },
            { TypeSymbol.Int16, TypeSymbol.Int32 },
            { TypeSymbol.Int16, TypeSymbol.Int64 },
            { TypeSymbol.Int16, TypeSymbol.Float32 },
            { TypeSymbol.Int16, TypeSymbol.Float64 },
            { TypeSymbol.UInt16, TypeSymbol.Int32 },
            { TypeSymbol.UInt16, TypeSymbol.UInt32 },
            { TypeSymbol.UInt16, TypeSymbol.Int64 },
            { TypeSymbol.Int32, TypeSymbol.Int64 },
            { TypeSymbol.Int32, TypeSymbol.Float32 },
            { TypeSymbol.Int32, TypeSymbol.Float64 },
            { TypeSymbol.Int32, TypeSymbol.Decimal },
            { TypeSymbol.UInt32, TypeSymbol.Int64 },
            { TypeSymbol.UInt32, TypeSymbol.UInt64 },
            { TypeSymbol.UInt32, TypeSymbol.Decimal },
            { TypeSymbol.Int64, TypeSymbol.Float64 },
            { TypeSymbol.Int64, TypeSymbol.Decimal },
            { TypeSymbol.UInt64, TypeSymbol.Decimal },
            { TypeSymbol.Float32, TypeSymbol.Float64 },
            { TypeSymbol.Char, TypeSymbol.UInt16 },
            { TypeSymbol.Char, TypeSymbol.Int32 },
            { TypeSymbol.Char, TypeSymbol.UInt32 },
            { TypeSymbol.Char, TypeSymbol.Float64 },
            { TypeSymbol.NInt, TypeSymbol.Int64 },
            { TypeSymbol.NInt, TypeSymbol.Float64 },
            { TypeSymbol.NUInt, TypeSymbol.UInt64 },
        };
        return data;
    }

    public static TheoryData<TypeSymbol, TypeSymbol> ExplicitNumericNarrowings()
    {
        var data = new TheoryData<TypeSymbol, TypeSymbol>
        {
            { TypeSymbol.Int32, TypeSymbol.UInt8 },
            { TypeSymbol.Int32, TypeSymbol.Int8 },
            { TypeSymbol.Int32, TypeSymbol.Int16 },
            { TypeSymbol.Int32, TypeSymbol.UInt16 },
            { TypeSymbol.Int32, TypeSymbol.UInt32 },
            { TypeSymbol.Int32, TypeSymbol.Char },
            { TypeSymbol.Int64, TypeSymbol.Int32 },
            { TypeSymbol.Int64, TypeSymbol.UInt32 },
            { TypeSymbol.UInt64, TypeSymbol.Int32 },
            { TypeSymbol.UInt64, TypeSymbol.Int64 },
            { TypeSymbol.Float64, TypeSymbol.Float32 },
            { TypeSymbol.Float64, TypeSymbol.Int32 },
            { TypeSymbol.Float32, TypeSymbol.Int32 },
            { TypeSymbol.Decimal, TypeSymbol.Int32 },
            { TypeSymbol.Decimal, TypeSymbol.Int64 },
            { TypeSymbol.Decimal, TypeSymbol.Float32 },
            { TypeSymbol.Decimal, TypeSymbol.Float64 },
        };
        return data;
    }

    [Theory]
    [MemberData(nameof(ImplicitNumericWidenings))]
    public void NumericWidening_IsImplicit(TypeSymbol from, TypeSymbol to)
    {
        var conv = Conversion.Classify(from, to);
        Assert.True(conv.Exists, $"expected {from.Name} -> {to.Name} to exist");
        Assert.True(conv.IsImplicit, $"expected {from.Name} -> {to.Name} to be implicit");
    }

    [Theory]
    [MemberData(nameof(ExplicitNumericNarrowings))]
    public void NumericNarrowing_IsExplicit(TypeSymbol from, TypeSymbol to)
    {
        var conv = Conversion.Classify(from, to);
        Assert.True(conv.Exists, $"expected {from.Name} -> {to.Name} to exist");
        Assert.True(conv.IsExplicit, $"expected {from.Name} -> {to.Name} to be explicit (got implicit={conv.IsImplicit})");
    }

    [Theory]
    [InlineData("Int", "Int")]
    [InlineData("Long", "Long")]
    [InlineData("Decimal", "Decimal")]
    [InlineData("Char", "Char")]
    public void Identity_IsIdentity(string fromName, string toName)
    {
        var from = LookupPrimitive(fromName);
        var to = LookupPrimitive(toName);
        var conv = Conversion.Classify(from, to);
        Assert.True(conv.IsIdentity);
    }

    [Fact]
    public void Int_To_UInt_IsExplicit()
    {
        // Same width but signed/unsigned: explicit per C# §6.2.1.
        var conv = Conversion.Classify(TypeSymbol.Int32, TypeSymbol.UInt32);
        Assert.True(conv.IsExplicit);
    }

    [Fact]
    public void Bool_To_Int_HasNoNumericConversion()
    {
        // bool is not in the numeric lattice; no conversion exists in
        // either direction. (The IL-level bool↔int helpers in the emitter
        // are reachable only through unrelated paths such as the discarded
        // result of an equality test.)
        var conv = Conversion.Classify(TypeSymbol.Bool, TypeSymbol.Int32);
        Assert.False(conv.Exists);
    }

    [Fact]
    public void Int_To_Object_IsImplicit_Boxing()
    {
        var conv = Conversion.Classify(TypeSymbol.Int32, TypeSymbol.Object);
        Assert.True(conv.IsImplicit, "value-type → object is implicit boxing per ADR-0045");
    }

    [Fact]
    public void Decimal_To_Object_IsImplicit_Boxing()
    {
        var conv = Conversion.Classify(TypeSymbol.Decimal, TypeSymbol.Object);
        Assert.True(conv.IsImplicit);
    }

    [Fact]
    public void Object_To_Int_IsExplicit_Unbox()
    {
        var conv = Conversion.Classify(TypeSymbol.Object, TypeSymbol.Int32);
        Assert.True(conv.IsExplicit, "object → value-type is explicit unboxing per ADR-0045");
    }

    [Fact]
    public void String_To_Object_IsImplicit_Reference()
    {
        var conv = Conversion.Classify(TypeSymbol.String, TypeSymbol.Object);
        Assert.True(conv.IsImplicit, "reference type → object is implicit reference conversion");
    }

    private static TypeSymbol LookupPrimitive(string name) => name switch
    {
        "Int" => TypeSymbol.Int32,
        "Long" => TypeSymbol.Int64,
        "Decimal" => TypeSymbol.Decimal,
        "Char" => TypeSymbol.Char,
        _ => throw new System.ArgumentException($"unknown primitive '{name}'"),
    };
}
