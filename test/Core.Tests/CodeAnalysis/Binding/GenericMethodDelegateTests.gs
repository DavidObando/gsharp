// <copyright file="GenericMethodDelegateTests.cs" company="GSharp">
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

/// Issue #312 follow-up — a method (or free) type parameter used as a generic
/// argument of a delegate type, e.g. `func Map[U](f (T) -> U) U`. The
/// binder must substitute type parameters that appear inside a
/// (cref:FunctionTypeSymbol) (parameter and return positions) so the
/// delegate argument type-checks, and the substituted return type must flow to
/// the call site.
open class GenericMethodDelegateTests {
    @Fact
    func GenericMethod_DelegateParameterOverTypeParameters_Binds() {
        let source = `
class Box[TItem] {
    var Value TItem
    func Map[TResult](f (TItem) -> TResult) TResult {
        return f(this.Value)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericMethod_DelegateParameter_ValueTypeRoundTrips() {
        let source = `
class Box[TItem] {
    var Value TItem
    func Map[TResult](f (TItem) -> TResult) TResult {
        return f(this.Value)
    }
}
var b = Box[int32]{Value: 21}
b.Map[int32](func(x int32) int32 { return x + x })
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GenericMethod_DelegateParameter_ReferenceTypeReturn() {
        let source = `
class Box[TItem] {
    var Value TItem
    func Map[TResult](f (TItem) -> TResult) TResult {
        return f(this.Value)
    }
}
var b = Box[int32]{Value: 21}
b.Map[string](func(x int32) string { return "mapped" })
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("mapped", result.Value)
    }

    @Fact
    func GenericMethod_MultipleDelegateParameters_Bind() {
        let source = `
class Box[TItem] {
    var Value TItem
    func Fold[TAcc](seed TAcc, f (TAcc, TItem) -> TAcc) TAcc {
        return f(seed, this.Value)
    }
}
var b = Box[int32]{Value: 21}
b.Fold[int32](100, func(acc int32, x int32) int32 { return acc + x })
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(121, result.Value)
    }

    @Fact
    func FreeGenericFunction_DelegateParameterOverTypeParameters_Binds() {
        let source = `
func Apply[T, U](x T, f (T) -> U) U {
    return f(x)
}
Apply[int32, bool](5, func(x int32) bool { return x > 3 })
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func FreeGenericFunction_DelegateReturnInferred_Substitutes() {
        let source = `
func Apply[T, U](x T, f (T) -> U) U {
    return f(x)
}
Apply(7, func(x int32) int32 { return x * 2 })
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(14, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
