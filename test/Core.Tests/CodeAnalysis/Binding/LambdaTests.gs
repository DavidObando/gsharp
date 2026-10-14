// <copyright file="LambdaTests.cs" company="GSharp">
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

/// Phase 4.7 — first-class function types (`func(T) R`), function literals,
/// indirect calls, and closure capture.
open class LambdaTests {
    @Fact
    func FunctionLiteral_DirectInvocation_ReturnsResult() {
        let result = Evaluate(`
let add = func(a int32, b int32) int32 { return a + b }
add(2, 3)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func FunctionTypeClause_OnLocal_AcceptsMatchingLiteral() {
        let result = Evaluate(`
let add (int32, int32) -> int32 = func(a int32, b int32) int32 { return a + b }
add(4, 5)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func Closure_CapturesLocalByValue() {
        let result = Evaluate(`
let n = 7
let f = func() int32 { return n + 1 }
f()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(8, result.Value)
    }

    @Fact
    func Closure_CapturedLocalSharesVariableCell() {
        let result = Evaluate(`
func makeReader() () -> int32 {
    var n = 1
    let f = func() int32 { return n }
    n = 99
    return f
}
let r = makeReader()
r()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func FunctionLiteral_VoidReturn_Works() {
        let result = Evaluate(`
let noop = func() { }
noop()
1
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func IndirectCall_WrongArgCount_ReportsDiagnostic() {
        let result = Evaluate(`
let add = func(a int32, b int32) int32 { return a + b }
add(1)
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func MethodGroup_NamedFunction_ConvertsToNativeFuncType() {
        // Issue #324: a bare function name in a value context expecting a
        // compatible delegate converts to a method group — no lambda wrapper.
        let result = Evaluate(`
func inc(x int32) int32 { return x + 1 }
let f (int32) -> int32 = inc
f(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func MethodGroup_NamedFunction_PassedAsCallbackArgument() {
        // Issue #324: a method group flows into a `(...) -> R`-typed parameter.
        let result = Evaluate(`
func twice(x int32) int32 { return x * 2 }
func apply(g (int32) -> int32, v int32) int32 { return g(v) }
apply(twice, 21)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
