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
            { TypeSymbol.SByte, TypeSymbol.Short },
            { TypeSymbol.SByte, TypeSymbol.Int },
            { TypeSymbol.SByte, TypeSymbol.Long },
            { TypeSymbol.SByte, TypeSymbol.Float32 },
            { TypeSymbol.SByte, TypeSymbol.Float64 },
            { TypeSymbol.SByte, TypeSymbol.Decimal },
            { TypeSymbol.Byte, TypeSymbol.Short },
            { TypeSymbol.Byte, TypeSymbol.UShort },
            { TypeSymbol.Byte, TypeSymbol.Int },
            { TypeSymbol.Byte, TypeSymbol.UInt },
            { TypeSymbol.Byte, TypeSymbol.Long },
            { TypeSymbol.Byte, TypeSymbol.ULong },
            { TypeSymbol.Byte, TypeSymbol.Decimal },
            { TypeSymbol.Short, TypeSymbol.Int },
            { TypeSymbol.Short, TypeSymbol.Long },
            { TypeSymbol.Short, TypeSymbol.Float32 },
            { TypeSymbol.Short, TypeSymbol.Float64 },
            { TypeSymbol.UShort, TypeSymbol.Int },
            { TypeSymbol.UShort, TypeSymbol.UInt },
            { TypeSymbol.UShort, TypeSymbol.Long },
            { TypeSymbol.Int, TypeSymbol.Long },
            { TypeSymbol.Int, TypeSymbol.Float32 },
            { TypeSymbol.Int, TypeSymbol.Float64 },
            { TypeSymbol.Int, TypeSymbol.Decimal },
            { TypeSymbol.UInt, TypeSymbol.Long },
            { TypeSymbol.UInt, TypeSymbol.ULong },
            { TypeSymbol.UInt, TypeSymbol.Decimal },
            { TypeSymbol.Long, TypeSymbol.Float64 },
            { TypeSymbol.Long, TypeSymbol.Decimal },
            { TypeSymbol.ULong, TypeSymbol.Decimal },
            { TypeSymbol.Float32, TypeSymbol.Float64 },
            { TypeSymbol.Char, TypeSymbol.UShort },
            { TypeSymbol.Char, TypeSymbol.Int },
            { TypeSymbol.Char, TypeSymbol.UInt },
            { TypeSymbol.Char, TypeSymbol.Float64 },
            { TypeSymbol.NInt, TypeSymbol.Long },
            { TypeSymbol.NInt, TypeSymbol.Float64 },
            { TypeSymbol.NUInt, TypeSymbol.ULong },
        };
        return data;
    }

    public static TheoryData<TypeSymbol, TypeSymbol> ExplicitNumericNarrowings()
    {
        var data = new TheoryData<TypeSymbol, TypeSymbol>
        {
            { TypeSymbol.Int, TypeSymbol.Byte },
            { TypeSymbol.Int, TypeSymbol.SByte },
            { TypeSymbol.Int, TypeSymbol.Short },
            { TypeSymbol.Int, TypeSymbol.UShort },
            { TypeSymbol.Int, TypeSymbol.UInt },
            { TypeSymbol.Int, TypeSymbol.Char },
            { TypeSymbol.Long, TypeSymbol.Int },
            { TypeSymbol.Long, TypeSymbol.UInt },
            { TypeSymbol.ULong, TypeSymbol.Int },
            { TypeSymbol.ULong, TypeSymbol.Long },
            { TypeSymbol.Float64, TypeSymbol.Float32 },
            { TypeSymbol.Float64, TypeSymbol.Int },
            { TypeSymbol.Float32, TypeSymbol.Int },
            { TypeSymbol.Decimal, TypeSymbol.Int },
            { TypeSymbol.Decimal, TypeSymbol.Long },
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
        var conv = Conversion.Classify(TypeSymbol.Int, TypeSymbol.UInt);
        Assert.True(conv.IsExplicit);
    }

    [Fact]
    public void Bool_To_Int_HasNoNumericConversion()
    {
        // bool is not in the numeric lattice; no conversion exists in
        // either direction. (The IL-level bool↔int helpers in the emitter
        // are reachable only through unrelated paths such as the discarded
        // result of an equality test.)
        var conv = Conversion.Classify(TypeSymbol.Bool, TypeSymbol.Int);
        Assert.False(conv.Exists);
    }

    [Fact]
    public void Int_To_Object_IsImplicit_Boxing()
    {
        var conv = Conversion.Classify(TypeSymbol.Int, TypeSymbol.Object);
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
        var conv = Conversion.Classify(TypeSymbol.Object, TypeSymbol.Int);
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
        "Int" => TypeSymbol.Int,
        "Long" => TypeSymbol.Long,
        "Decimal" => TypeSymbol.Decimal,
        "Char" => TypeSymbol.Char,
        _ => throw new System.ArgumentException($"unknown primitive '{name}'"),
    };
}
