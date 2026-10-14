// <copyright file="NullableTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Phase 3.C.1 — nullable type syntax `T?` per ADR-0001.
open class NullableTypeTests {
    @Fact
    func Nullable_Identity_RoundTrip() {
        let source = `
var x int32? = 7
x
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NullableTypeSymbol_Caches_Same_Underlying() {
        let a = NullableTypeSymbol.Get(TypeSymbol.Int32)
        let b = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.Same(a, b)
        Assert.Same(TypeSymbol.Int32, a.UnderlyingType)
        Assert.Equal("int32?", a.Name)
    }

    @Fact
    func NullableTypeSymbol_DoubleWrap_NoOp() {
        let once = NullableTypeSymbol.Get(TypeSymbol.String)
        let twice = NullableTypeSymbol.Get(once)
        Assert.Same(once, twice)
    }

    @Fact
    func Parser_AcceptsQuestionOnArrayElementType() {
        // The parser must accept `[3]int?` as a type clause (questioned element type).
        let source = `
struct X {
    var Items [3]int32?
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Nil_AssignedToNullable_Binds() {
        let source = `
var x int32? = nil
x == nil
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Nil_AssignedToNonNullable_Diagnoses() {
        let source = `
var x int32 = nil
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
