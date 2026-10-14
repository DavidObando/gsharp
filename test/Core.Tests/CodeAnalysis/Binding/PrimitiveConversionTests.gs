// <copyright file="PrimitiveConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import Xunit

/// Phase 3 of #142: exercises (cref:Conversion.Classify) across the
/// full ADR-0044 numeric lattice and the ADR-0045 object boxing/unboxing
/// rules. Each test pair pins one cell in the conversion matrix so a
/// future refactor of the table can be caught here rather than via a
/// downstream emission or execution failure.
open class PrimitiveConversionTests {
    @Theory
    @MemberData("ImplicitNumericWidenings")
    func NumericWidening_IsImplicit(from TypeSymbol, to TypeSymbol) {
        let conv = Conversion.Classify(from, to)
        Assert.True(conv.Exists, "expected ${from.Name} -> ${to.Name} to exist")
        Assert.True(conv.IsImplicit, "expected ${from.Name} -> ${to.Name} to be implicit")
    }

    @Theory
    @MemberData("ExplicitNumericNarrowings")
    func NumericNarrowing_IsExplicit(from TypeSymbol, to TypeSymbol) {
        let conv = Conversion.Classify(from, to)
        Assert.True(conv.Exists, "expected ${from.Name} -> ${to.Name} to exist")
        Assert.True(
            conv.IsExplicit,
            "expected ${from.Name} -> ${to.Name} to be explicit (got implicit=${conv.IsImplicit})"
        )
    }

    @Theory
    @InlineData("Int", "Int")
    @InlineData("Long", "Long")
    @InlineData("Decimal", "Decimal")
    @InlineData("Char", "Char")
    func Identity_IsIdentity(fromName string, toName string) {
        let from = LookupPrimitive(fromName)
        let to = LookupPrimitive(toName)
        let conv = Conversion.Classify(from, to)
        Assert.True(conv.IsIdentity)
    }

    @Fact
    func Int_To_UInt_IsExplicit() {
        // Same width but signed/unsigned: explicit per C# §6.2.1.
        let conv = Conversion.Classify(TypeSymbol.Int32, TypeSymbol.UInt32)
        Assert.True(conv.IsExplicit)
    }

    @Fact
    func Bool_To_Int_HasNoNumericConversion() {
        // bool is not in the numeric lattice; no conversion exists in
        // either direction. (The IL-level bool↔int helpers in the emitter
        // are reachable only through unrelated paths such as the discarded
        // result of an equality test.)
        let conv = Conversion.Classify(TypeSymbol.Bool, TypeSymbol.Int32)
        Assert.False(conv.Exists)
    }

    @Fact
    func Int_To_Object_IsImplicit_Boxing() {
        let conv = Conversion.Classify(TypeSymbol.Int32, TypeSymbol.Object)
        Assert.True(conv.IsImplicit, "value-type → object is implicit boxing per ADR-0045")
    }

    @Fact
    func Decimal_To_Object_IsImplicit_Boxing() {
        let conv = Conversion.Classify(TypeSymbol.Decimal, TypeSymbol.Object)
        Assert.True(conv.IsImplicit)
    }

    @Fact
    func Object_To_Int_IsExplicit_Unbox() {
        let conv = Conversion.Classify(TypeSymbol.Object, TypeSymbol.Int32)
        Assert.True(conv.IsExplicit, "object → value-type is explicit unboxing per ADR-0045")
    }

    @Fact
    func String_To_Object_IsImplicit_Reference() {
        let conv = Conversion.Classify(TypeSymbol.String, TypeSymbol.Object)
        Assert.True(conv.IsImplicit, "reference type → object is implicit reference conversion")
    }

    shared {
        func ImplicitNumericWidenings() TheoryData[TypeSymbol, TypeSymbol] {
            let data = TheoryData[TypeSymbol, TypeSymbol]{
                TypeSymbol.Int8: TypeSymbol.Int16,
                TypeSymbol.Int8: TypeSymbol.Int32,
                TypeSymbol.Int8: TypeSymbol.Int64,
                TypeSymbol.Int8: TypeSymbol.Float32,
                TypeSymbol.Int8: TypeSymbol.Float64,
                TypeSymbol.Int8: TypeSymbol.Decimal,
                TypeSymbol.UInt8: TypeSymbol.Int16,
                TypeSymbol.UInt8: TypeSymbol.UInt16,
                TypeSymbol.UInt8: TypeSymbol.Int32,
                TypeSymbol.UInt8: TypeSymbol.UInt32,
                TypeSymbol.UInt8: TypeSymbol.Int64,
                TypeSymbol.UInt8: TypeSymbol.UInt64,
                TypeSymbol.UInt8: TypeSymbol.Decimal,
                TypeSymbol.Int16: TypeSymbol.Int32,
                TypeSymbol.Int16: TypeSymbol.Int64,
                TypeSymbol.Int16: TypeSymbol.Float32,
                TypeSymbol.Int16: TypeSymbol.Float64,
                TypeSymbol.UInt16: TypeSymbol.Int32,
                TypeSymbol.UInt16: TypeSymbol.UInt32,
                TypeSymbol.UInt16: TypeSymbol.Int64,
                TypeSymbol.Int32: TypeSymbol.Int64,
                TypeSymbol.Int32: TypeSymbol.Float32,
                TypeSymbol.Int32: TypeSymbol.Float64,
                TypeSymbol.Int32: TypeSymbol.Decimal,
                TypeSymbol.UInt32: TypeSymbol.Int64,
                TypeSymbol.UInt32: TypeSymbol.UInt64,
                TypeSymbol.UInt32: TypeSymbol.Decimal,
                TypeSymbol.Int64: TypeSymbol.Float64,
                TypeSymbol.Int64: TypeSymbol.Decimal,
                TypeSymbol.UInt64: TypeSymbol.Decimal,
                TypeSymbol.Float32: TypeSymbol.Float64,
                TypeSymbol.Char: TypeSymbol.UInt16,
                TypeSymbol.Char: TypeSymbol.Int32,
                TypeSymbol.Char: TypeSymbol.UInt32,
                TypeSymbol.Char: TypeSymbol.Float64,
                TypeSymbol.NInt: TypeSymbol.Int64,
                TypeSymbol.NInt: TypeSymbol.Float64,
                TypeSymbol.NUInt: TypeSymbol.UInt64
            }
            return data
        }

        func ExplicitNumericNarrowings() TheoryData[TypeSymbol, TypeSymbol] {
            let data = TheoryData[TypeSymbol, TypeSymbol]{
                TypeSymbol.Int32: TypeSymbol.UInt8,
                TypeSymbol.Int32: TypeSymbol.Int8,
                TypeSymbol.Int32: TypeSymbol.Int16,
                TypeSymbol.Int32: TypeSymbol.UInt16,
                TypeSymbol.Int32: TypeSymbol.UInt32,
                TypeSymbol.Int32: TypeSymbol.Char,
                TypeSymbol.Int64: TypeSymbol.Int32,
                TypeSymbol.Int64: TypeSymbol.UInt32,
                TypeSymbol.UInt64: TypeSymbol.Int32,
                TypeSymbol.UInt64: TypeSymbol.Int64,
                TypeSymbol.Float64: TypeSymbol.Float32,
                TypeSymbol.Float64: TypeSymbol.Int32,
                TypeSymbol.Float32: TypeSymbol.Int32,
                TypeSymbol.Decimal: TypeSymbol.Int32,
                TypeSymbol.Decimal: TypeSymbol.Int64,
                TypeSymbol.Decimal: TypeSymbol.Float32,
                TypeSymbol.Decimal: TypeSymbol.Float64
            }
            return data
        }

        private func LookupPrimitive(name string) TypeSymbol -> switch name {
            case "Int": TypeSymbol.Int32
            case "Long": TypeSymbol.Int64
            case "Decimal": TypeSymbol.Decimal
            case "Char": TypeSymbol.Char
            default: throw ArgumentException("unknown primitive '$name'")
        }
    }
}
