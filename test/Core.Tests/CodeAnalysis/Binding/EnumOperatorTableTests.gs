// <copyright file="EnumOperatorTableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import Xunit

/// Unit tests for (cref:EnumOperatorTable): validates each row in
/// the binary/unary tables, negative cases, and helper methods.
open class EnumOperatorTableTests {
    // ── TryBindBinary: comparison operators ────────────────────────────
    @Theory
    @InlineData(SyntaxKind(42), BoundBinaryOperatorKind(12))
    @InlineData(SyntaxKind(44), BoundBinaryOperatorKind(13))
    @InlineData(SyntaxKind(51), BoundBinaryOperatorKind(14))
    @InlineData(SyntaxKind(52), BoundBinaryOperatorKind(15))
    @InlineData(SyntaxKind(57), BoundBinaryOperatorKind(16))
    @InlineData(SyntaxKind(58), BoundBinaryOperatorKind(17))
    func Comparison_SameEnum_ReturnsBool(syntax SyntaxKind, expectedKind BoundBinaryOperatorKind) {
        Assert.True(EnumOperatorTable.TryBindBinary(syntax, DayOfWeekType, DayOfWeekType, out var kind, out var result))
        Assert.Equal(expectedKind, kind)
        Assert.Equal(TypeSymbol.Bool, result)
    }

    // ── TryBindBinary: bitwise operators ──────────────────────────────
    @Theory
    @InlineData(SyntaxKind(38), BoundBinaryOperatorKind(10))
    @InlineData(SyntaxKind(33), BoundBinaryOperatorKind(6))
    @InlineData(SyntaxKind(30), BoundBinaryOperatorKind(11))
    func Bitwise_SameEnum_ReturnsEnum(syntax SyntaxKind, expectedKind BoundBinaryOperatorKind) {
        Assert.True(EnumOperatorTable.TryBindBinary(syntax, DayOfWeekType, DayOfWeekType, out var kind, out var result))
        Assert.Equal(expectedKind, kind)
        Assert.Equal(DayOfWeekType, result)
    }

    // ── TryBindBinary: arithmetic operators ───────────────────────────
    @Fact
    func Plus_EnumUnderlying_ReturnsEnum() {
        Assert.True(
            EnumOperatorTable.TryBindBinary(
                SyntaxKind.PlusToken,
                DayOfWeekType,
                TypeSymbol.Int32,
                out var kind,
                out var result
            )
        )
        Assert.Equal(BoundBinaryOperatorKind.Sum, kind)
        Assert.Equal(DayOfWeekType, result)
    }

    @Fact
    func Plus_UnderlyingEnum_ReturnsEnum() {
        Assert.True(
            EnumOperatorTable.TryBindBinary(
                SyntaxKind.PlusToken,
                TypeSymbol.Int32,
                DayOfWeekType,
                out var kind,
                out var result
            )
        )
        Assert.Equal(BoundBinaryOperatorKind.Sum, kind)
        Assert.Equal(DayOfWeekType, result)
    }

    @Fact
    func Minus_EnumUnderlying_ReturnsEnum() {
        Assert.True(
            EnumOperatorTable.TryBindBinary(
                SyntaxKind.MinusToken,
                DayOfWeekType,
                TypeSymbol.Int32,
                out var kind,
                out var result
            )
        )
        Assert.Equal(BoundBinaryOperatorKind.Difference, kind)
        Assert.Equal(DayOfWeekType, result)
    }

    @Fact
    func Minus_EnumEnum_ReturnsUnderlying() {
        Assert.True(
            EnumOperatorTable.TryBindBinary(
                SyntaxKind.MinusToken,
                DayOfWeekType,
                DayOfWeekType,
                out var kind,
                out var result
            )
        )
        Assert.Equal(BoundBinaryOperatorKind.Difference, kind)
        Assert.Equal(TypeSymbol.Int32, result)
    }

    // ── TryBindBinary: negative cases ─────────────────────────────────
    @Fact
    func Star_EnumEnum_NotSupported() {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.StarToken, DayOfWeekType, DayOfWeekType, out _, out _))
    }

    @Fact
    func Slash_EnumUnderlying_NotSupported() {
        Assert.False(
            EnumOperatorTable.TryBindBinary(SyntaxKind.SlashToken, DayOfWeekType, TypeSymbol.Int32, out _, out _)
        )
    }

    @Fact
    func ShiftLeft_Enum_NotSupported() {
        Assert.False(
            EnumOperatorTable.TryBindBinary(SyntaxKind.ShiftLeftToken, DayOfWeekType, TypeSymbol.Int32, out _, out _)
        )
    }

    @Fact
    func MixedEnums_NotSupported() {
        Assert.False(
            EnumOperatorTable.TryBindBinary(SyntaxKind.EqualsEqualsToken, DayOfWeekType, ConsoleKeyType, out _, out _)
        )
    }

    @Fact
    func Plus_EnumWrongUnderlying_NotSupported() {
        // DayOfWeek is int-backed; int64 is not the underlying type.
        Assert.False(
            EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, DayOfWeekType, TypeSymbol.Int64, out _, out _)
        )
    }

    @Fact
    func NullTypes_NotSupported() {
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, nil, DayOfWeekType, out _, out _))
        Assert.False(EnumOperatorTable.TryBindBinary(SyntaxKind.PlusToken, DayOfWeekType, nil, out _, out _))
    }

    // ── TryBindUnary ──────────────────────────────────────────────────
    @Fact
    func UnaryTilde_Enum_ReturnsOnesComplement() {
        Assert.True(EnumOperatorTable.TryBindUnary(SyntaxKind.TildeToken, DayOfWeekType, out var kind, out var result))
        Assert.Equal(BoundUnaryOperatorKind.OnesComplement, kind)
        Assert.Equal(DayOfWeekType, result)
    }

    @Fact
    func UnaryMinus_Enum_NotSupported() {
        Assert.False(EnumOperatorTable.TryBindUnary(SyntaxKind.MinusToken, DayOfWeekType, out _, out _))
    }

    @Fact
    func UnaryTilde_NonEnum_NotSupported() {
        Assert.False(EnumOperatorTable.TryBindUnary(SyntaxKind.TildeToken, TypeSymbol.Int32, out _, out _))
    }

    // ── IsUnsignedEnumUnderlying ──────────────────────────────────────
    @Fact
    func IsUnsignedEnumUnderlying_SignedEnum_ReturnsFalse() {
        // DayOfWeek is int32-backed (signed)
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(DayOfWeekType))
    }

    @Fact
    func IsUnsignedEnumUnderlying_NonEnum_ReturnsFalse() {
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(TypeSymbol.Int32))
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(TypeSymbol.UInt32))
        Assert.False(EnumOperatorTable.IsUnsignedEnumUnderlying(nil))
    }

    // ── IsEnumType ────────────────────────────────────────────────────
    @Fact
    func IsEnumType_ImportedEnum_ReturnsTrue() {
        Assert.True(EnumOperatorTable.IsEnumType(DayOfWeekType))
    }

    @Fact
    func IsEnumType_NullableEnum_ReturnsFalse() {
        let nullable = NullableTypeSymbol.Get(DayOfWeekType)
        Assert.False(EnumOperatorTable.IsEnumType(nullable))
    }

    @Fact
    func IsEnumType_Primitive_ReturnsFalse() {
        Assert.False(EnumOperatorTable.IsEnumType(TypeSymbol.Int32))
        Assert.False(EnumOperatorTable.IsEnumType(TypeSymbol.Bool))
    }

    @Fact
    func IsEnumType_Null_ReturnsFalse() {
        Assert.False(EnumOperatorTable.IsEnumType(nil))
    }

    // ── GetUnderlyingType ─────────────────────────────────────────────
    @Fact
    func GetUnderlyingType_ImportedEnum_ReturnsInt32() {
        // DayOfWeek is int32-backed
        Assert.Equal(TypeSymbol.Int32, EnumOperatorTable.GetUnderlyingType(DayOfWeekType))
    }

    @Fact
    func GetUnderlyingType_NonEnum_ReturnsNull() {
        Assert.Null(EnumOperatorTable.GetUnderlyingType(TypeSymbol.Int32))
        Assert.Null(EnumOperatorTable.GetUnderlyingType(nil))
    }

    shared {
        private let DayOfWeekType TypeSymbol = ImportedTypeSymbol.Get(typeof(DayOfWeek))
        private let ConsoleKeyType TypeSymbol = ImportedTypeSymbol.Get(typeof(ConsoleKey))
    }
}
