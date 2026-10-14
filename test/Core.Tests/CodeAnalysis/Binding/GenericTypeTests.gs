// <copyright file="GenericTypeTests.cs" company="GSharp">
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

/// Phase 4.3a / ADR-0020 — generic data-struct/class declarations and
/// composite-literal instantiation. Constructed StructSymbols are cached so
/// reference equality holds for identical type-argument sequences.
open class GenericTypeTests {
    @Fact
    func GenericDataStruct_ExplicitTypeArgs_FieldAccessReturnsValue() {
        let source = `
data struct Result[T any, E any] {
    var Ok T
    var Err E
}
let r = Result[int32, string]{Ok: 5, Err: "oops"}
r.Ok
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func GenericDataStruct_InferredTypeArgs_FieldAccessReturnsValue() {
        let source = `
data struct Box[T any] {
    var Value T
}
let b = Box{Value: 42}
b.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GenericDataStruct_StructuralEquality_HoldsForEqualValues() {
        let source = `
data struct Pair[A any, B any] {
    var First A
    var Second B
}
let p1 = Pair[int32, string]{First: 1, Second: "x"}
let p2 = Pair[int32, string]{First: 1, Second: "x"}
p1 == p2
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func GenericDataStruct_WrongArity_Diagnoses() {
        let source = `
data struct Result[T any, E any] {
    var Ok T
    var Err E
}
let r = Result[int32]{Ok: 5, Err: "oops"}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("type argument"))
    }

    @Fact
    func GenericClass_PrimaryCtorInferred_FieldAccessReturnsValue() {
        let source = `
class Box[T any](Value T) {
}
let b = Box(7)
b.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func GenericClass_PrimaryCtorExplicit_FieldAccessReturnsValue() {
        let source = `
class Box[T any](Value T) {
}
let b = Box[string]("hi")
b.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func GenericClass_MethodCall_TypeChecksAndExecutes() {
        let source = `
class Holder[T any](value T) {
    func Get() T { return value }
}
let h = Holder(42)
h.Get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
