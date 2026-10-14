// <copyright file="PrimitiveTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import Xunit

/// ADR-0044 / ADR-0045: built-in primitive type symbols and their
/// (cref:TypeSymbol.FromClrType(Type)) mapping.
///
/// Phase 1 of issue #142 — confirms each new symbol exists, exposes the
/// correct CLR type, and round-trips through `FromClrType`.
open class PrimitiveTypeSymbolTests {
    @Theory
    @MemberData("PrimitiveTypeData")
    func PrimitiveSymbol_HasCanonicalNameAndClrType(symbol TypeSymbol, expectedClrType Type, expectedName string) {
        Assert.Equal(expectedName, symbol.Name)
        Assert.Same(expectedClrType, symbol.ClrType)
    }

    @Theory
    @MemberData("PrimitiveTypeData")
    func FromClrType_MapsBackToCanonicalSymbol(symbol TypeSymbol, clrType Type, expectedName string) {
        Assert.Same(symbol, TypeSymbol.FromClrType(clrType))
    }

    @Fact
    func FromClrType_NullableValueTypes_LiftThroughEachPrimitive() {
        // Nullable<T> lifting (ADR-0001) still wraps each new value-type primitive.
        AssertNullableLifts(typeof(uint8?), TypeSymbol.UInt8)
        AssertNullableLifts(typeof(int8?), TypeSymbol.Int8)
        AssertNullableLifts(typeof(int16?), TypeSymbol.Int16)
        AssertNullableLifts(typeof(uint16?), TypeSymbol.UInt16)
        AssertNullableLifts(typeof(uint32?), TypeSymbol.UInt32)
        AssertNullableLifts(typeof(int64?), TypeSymbol.Int64)
        AssertNullableLifts(typeof(uint64?), TypeSymbol.UInt64)
        AssertNullableLifts(typeof(nint?), TypeSymbol.NInt)
        AssertNullableLifts(typeof(nuint?), TypeSymbol.NUInt)
        AssertNullableLifts(typeof(float32?), TypeSymbol.Float32)
        AssertNullableLifts(typeof(float64?), TypeSymbol.Float64)
        AssertNullableLifts(typeof(decimal?), TypeSymbol.Decimal)
        AssertNullableLifts(typeof(char?), TypeSymbol.Char)
    }

    shared {
        prop PrimitiveTypeData TheoryData[TypeSymbol, Type, string] -> {
            let values = TheoryData[TypeSymbol, Type, string]()
            values.Add(TypeSymbol.Bool, typeof(bool), "bool")
            values.Add(TypeSymbol.UInt8, typeof(uint8), "uint8")
            values.Add(TypeSymbol.Int8, typeof(int8), "int8")
            values.Add(TypeSymbol.Int16, typeof(int16), "int16")
            values.Add(TypeSymbol.UInt16, typeof(uint16), "uint16")
            values.Add(TypeSymbol.Int32, typeof(int32), "int32")
            values.Add(TypeSymbol.UInt32, typeof(uint32), "uint32")
            values.Add(TypeSymbol.Int64, typeof(int64), "int64")
            values.Add(TypeSymbol.UInt64, typeof(uint64), "uint64")
            values.Add(TypeSymbol.NInt, typeof(nint), "nint")
            values.Add(TypeSymbol.NUInt, typeof(nuint), "nuint")
            values.Add(TypeSymbol.Float32, typeof(float32), "float32")
            values.Add(TypeSymbol.Float64, typeof(float64), "float64")
            values.Add(TypeSymbol.Decimal, typeof(decimal), "decimal")
            values.Add(TypeSymbol.Char, typeof(char), "char")
            values.Add(TypeSymbol.String, typeof(string), "string")
            values.Add(TypeSymbol.Object, typeof(object), "object")
            values.Add(TypeSymbol.Void, typeof(Void), "void")
            values
        }

        private func AssertNullableLifts(nullableClrType Type, expectedUnderlying TypeSymbol) {
            let sym = TypeSymbol.FromClrType(nullableClrType)
            let nullable = Assert.IsType[NullableTypeSymbol](sym)
            Assert.Same(expectedUnderlying, nullable.UnderlyingType)
        }
    }
}
