// <copyright file="EnumOperatorTableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Unit tests for <see cref="EnumOperatorTable"/>: validates each row in
/// the binary/unary tables, negative cases, and helper methods.
/// </summary>
public class EnumOperatorTableTests
{
    private static readonly TypeSymbol DayOfWeekType = ImportedTypeSymbol.Get(typeof(DayOfWeek));
    private static readonly TypeSymbol ConsoleKeyType = ImportedTypeSymbol.Get(typeof(ConsoleKey));

    // ── TryBindBinary: comparison operators ────────────────────────────

    [Theory]
    [InlineData(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals)]
    [InlineData(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals)]
    [InlineData(SyntaxKind.LessToken, BoundBinaryOperatorKind.Less)]
    [InlineData(SyntaxKind.LessOrEqualsToken, BoundBinaryOperatorKind.LessOrEquals)]
    [InlineData(SyntaxKind.GreaterToken, BoundBinaryOperatorKind.Greater)]
    [InlineData(SyntaxKind.GreaterOrEqualsToken, BoundBinaryOperatorKind.GreaterOrEquals)]
    public void Comparison_SameEnum_ReturnsBool(SyntaxKind syntax, BoundBinaryOperatorKind expectedKind)
    {
        Assert.True(EnumOperatorTable.TryBindBinary(syntax, DayOfWeekType, DayOfWeekType, out var kind, out var result));
        Assert.Equal(expectedKind, kind);
        Assert.Equal(TypeSymbol.Bool, result);
    }

    // ── TryBindBinary: bitwise operators ──────────────────────────────

    [Theory]
    [InlineData(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr)]
    [InlineData(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd)]
    [InlineData(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor)]
    public void Bitwise_SameEnum_ReturnsEnum(SyntaxKind syntax, BoundBinaryOperatorKind expectedKind)
    {
        Assert.True(EnumOperatorTable.TryBindBinary(syntax, DayOfWeekType, DayOfWeekType, out var kind, out var result));
        Assert.Equal(expectedKind, kind);
        Assert.Equal(DayOfWeekType, result);
    }

    // ── TryBindBinary: arithmetic operators ───────────────────────────

    [Fact]
    public void Plus_EnumUnderlying_ReturnsEnum()
    {
        Assert.True(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, DayOfWeekType, TypeSymbol.Int32, out var kind, out var result));
        Assert.Equal(BoundBinaryOperatorKind.Sum, kind);
        Assert.Equal(DayOfWeekType, result);
    }

    [Fact]
    public void Plus_UnderlyingEnum_ReturnsEnum()
    {
        Assert.True(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, TypeSymbol.Int32, DayOfWeekType, out var kind, out var result));
        Assert.Equal(BoundBinaryOperatorKind.Sum, kind);
        Assert.Equal(DayOfWeekType, result);
    }

    [Fact]
    public void Minus_EnumUnderlying_ReturnsEnum()
    {
        Assert.True(EnumOperatorTable.TryBindBinary(SyntaxKind.MinusToken, DayOfWeekType, TypeSymbol.Int32, out var kind, out var result));
        Assert.Equal(BoundBinaryOperatorKind.Difference, kind);
        Assert.Equal(DayOfWeekType, result);
    }

    [Fact]
    public void Minus_EnumEnum_ReturnsUnderlying()
    {
        Assert.True(EnumOperatorTable.TryBindBinary(SyntaxKind.MinusToken, DayOfWeekType, DayOfWeekType, out var kind, out var result));
        Assert.Equal(BoundBinaryOperatorKind.Difference, kind);
        Assert.Equal(TypeSymbol.Int32, result);
    }

    // ── TryBindBinary: negative cases ─────────────────────────────────

    [Fact]
    public void Star_EnumEnum_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.StarToken, DayOfWeekType, DayOfWeekType, out _, out _));
    }

    [Fact]
    public void Slash_EnumUnderlying_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.SlashToken, DayOfWeekType, TypeSymbol.Int32, out _, out _));
    }

    [Fact]
    public void ShiftLeft_Enum_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.ShiftLeftToken, DayOfWeekType, TypeSymbol.Int32, out _, out _));
    }

    [Fact]
    public void MixedEnums_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.EqualsEqualsToken, DayOfWeekType, ConsoleKeyType, out _, out _));
    }

    [Fact]
    public void Plus_EnumWrongUnderlying_NotSupported()
    {
        // DayOfWeek is int-backed; int64 is not the underlying type.
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, DayOfWeekType, TypeSymbol.Int64, out _, out _));
    }

    [Fact]
    public void NullTypes_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, null, DayOfWeekType, out _, out _));
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, DayOfWeekType, null, out _, out _));
    }

    // ── TryBindUnary ──────────────────────────────────────────────────

    [Fact]
    public void UnaryHat_Enum_ReturnsOnesComplement()
    {
        Assert.True(EnumOperatorTable.TryBindUnary(SyntaxKind.HatToken, DayOfWeekType, out var kind, out var result));
        Assert.Equal(BoundUnaryOperatorKind.OnesComplement, kind);
        Assert.Equal(DayOfWeekType, result);
    }

    [Fact]
    public void UnaryMinus_Enum_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindUnary(SyntaxKind.MinusToken, DayOfWeekType, out _, out _));
    }

    [Fact]
    public void UnaryHat_NonEnum_NotSupported()
    {
        Assert.False(EnumOperatorTable.TryBindUnary(SyntaxKind.HatToken, TypeSymbol.Int32, out _, out _));
    }

    // ── IsUnsignedEnumUnderlying ──────────────────────────────────────

    [Fact]
    public void IsUnsignedEnumUnderlying_SignedEnum_ReturnsFalse()
    {
        // DayOfWeek is int32-backed (signed)
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(DayOfWeekType));
    }

    [Fact]
    public void IsUnsignedEnumUnderlying_NonEnum_ReturnsFalse()
    {
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(TypeSymbol.Int32));
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(TypeSymbol.UInt32));
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(null));
    }

    // ── IsEnumType ────────────────────────────────────────────────────

    [Fact]
    public void IsEnumType_ImportedEnum_ReturnsTrue()
    {
        Assert.True(EnumOperatorTable.IsEnumType(DayOfWeekType));
    }

    [Fact]
    public void IsEnumType_NullableEnum_ReturnsFalse()
    {
        var nullable = NullableTypeSymbol.Get(DayOfWeekType);
        Assert.False(EnumOperatorTable.IsEnumType(nullable));
    }

    [Fact]
    public void IsEnumType_Primitive_ReturnsFalse()
    {
        Assert.False(EnumOperatorTable.IsEnumType(TypeSymbol.Int32));
        Assert.False(EnumOperatorTable.IsEnumType(TypeSymbol.Bool));
    }

    [Fact]
    public void IsEnumType_Null_ReturnsFalse()
    {
        Assert.False(EnumOperatorTable.IsEnumType(null));
    }

    // ── GetUnderlyingType ─────────────────────────────────────────────

    [Fact]
    public void GetUnderlyingType_ImportedEnum_ReturnsInt32()
    {
        // DayOfWeek is int32-backed
        Assert.Equal(TypeSymbol.Int32, EnumOperatorTable.GetUnderlyingType(DayOfWeekType));
    }

    [Fact]
    public void GetUnderlyingType_NonEnum_ReturnsNull()
    {
        Assert.Null(EnumOperatorTable.GetUnderlyingType(TypeSymbol.Int32));
        Assert.Null(EnumOperatorTable.GetUnderlyingType(null));
    }
}
