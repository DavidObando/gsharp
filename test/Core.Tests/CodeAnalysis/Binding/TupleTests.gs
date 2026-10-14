// <copyright file="TupleTests.cs" company="GSharp">
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

/// Phase 4.5 — tuple types `(T1, T2, ...)`, tuple literals, and tuple
/// element access via `.Item1`..`.ItemN`.
open class TupleTests {
    @Fact
    func TupleLiteral_ItemAccess_ReturnsFirstElement() {
        let result = Evaluate(`
let p = (1, "x")
p.Item1
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func TupleLiteral_ItemAccess_ReturnsSecondElement() {
        let result = Evaluate(`
let p = (1, "x")
p.Item2
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("x", result.Value)
    }

    @Fact
    func TupleLiteral_ArityEight_ParsesAndBinds() {
        let syntaxTree = SyntaxTree.Parse(SourceText.From(`
let values = (1, 2, 3, 4, 5, 6, 7, 8)
values.Item8
`))
        let compilation = Compilation(syntaxTree)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
    }

    @Fact
    func TupleTypeClause_OnLocal_BindsAndEvaluates() {
        let result = Evaluate(`
let p (int32, string) = (7, "hi")
p.Item1
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func FunctionReturningTuple_AccessElement() {
        let result = Evaluate(`
func pair() (int32, int32) {
    return (3, 4)
}
let q = pair()
q.Item2
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func TupleAccess_OutOfRange_ReportsDiagnostic() {
        let source = `
let p = (1, "x")
p.Item3
`
        let result = EmittedOracle.Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Deconstruction_BindsNamedLocals() {
        let result = Evaluate(`
let (a, b) = (10, "ok")
a
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func Deconstruction_AccessesSecondElement() {
        let result = Evaluate(`
let (a, b) = (10, "ok")
b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func MultiReturn_PackedIntoTuple_DeconstructAtCallSite() {
        let result = Evaluate(`
func divmod(a int32, b int32) (int32, int32) {
    return a / b, a % b
}
let (q, r) = divmod(10, 3)
q
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func MultiReturn_RemainderAccessible() {
        let result = Evaluate(`
func divmod(a int32, b int32) (int32, int32) {
    return a / b, a % b
}
let (q, r) = divmod(10, 3)
r
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
