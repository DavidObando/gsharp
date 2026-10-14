// <copyright file="ByRefTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import Xunit

/// ADR-0039: Tests for (cref:ByRefTypeSymbol) — interning, equality, CLR type mapping.
open class ByRefTypeSymbolTests {
    @Fact
    func Get_Returns_Same_Instance_For_Same_Pointee() {
        let a = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        let b = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        Assert.Same(a, b)
    }

    @Fact
    func Get_Returns_Different_Instance_For_Different_Pointee() {
        let intRef = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        let boolRef = ByRefTypeSymbol.Get(TypeSymbol.Bool)
        Assert.NotSame(intRef, boolRef)
    }

    @Fact
    func PointeeType_Returns_Original() {
        let byRef = ByRefTypeSymbol.Get(TypeSymbol.String)
        Assert.Same(TypeSymbol.String, byRef.PointeeType)
    }

    @Fact
    func ClrType_Is_ByRef() {
        let byRef = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotNull(byRef.ClrType)
        Assert.True(byRef.ClrType!!.IsByRef)
        Assert.Equal(typeof(int32), byRef.ClrType!!.GetElementType())
    }

    @Fact
    func Name_Has_Star_Prefix() {
        let byRef = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        Assert.Equal("*int32", byRef.Name)
    }

    @Fact
    func PointeeType_Roundtrips() {
        let original = TypeSymbol.Bool
        let byRef = ByRefTypeSymbol.Get(original)
        Assert.Same(original, byRef.PointeeType)
        Assert.Equal("*bool", byRef.Name)
    }
}
