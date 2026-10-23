// <copyright file="Issue5131BodyFactsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #5131 — per-body facts are computed once per body object, and the
/// flow analyses share one lowering of each function literal. The counters
/// `bodyfacts.*` show which happened; the diagnostics must not change.
class Issue5131BodyFactsTests {
    @Fact
    func FunctionLiteral_IsLoweredOnceForTheTwoFlowAnalyses() {
        // Definite assignment and ref-struct liveness each need the lowered
        // literal body. The second one must reuse the first one's lowering.
        let (diagnostics, counters) = Bind(`
func Main() int32 {
    let add = func(a int32, b int32) int32 { return a + b }
    let twice = func(x int32) int32 { return add(x, x) }
    return twice(2)
}
`)
        Assert.Empty(diagnostics)
        Assert.Equal(2L, counters.LambdaLowerings)
        Assert.Equal(2L, counters.LambdaLoweringReuses)
    }

    @Fact
    func NestedFunctionLiteral_IsLoweredOncePerLiteral() {
        let (diagnostics, counters) = Bind(`
func Main() int32 {
    let outer = func(x int32) int32 {
        let inner = func(y int32) int32 { return y + 1 }
        return inner(x)
    }
    return outer(1)
}
`)
        Assert.Empty(diagnostics)
        Assert.Equal(2L, counters.LambdaLowerings)
        Assert.Equal(2L, counters.LambdaLoweringReuses)
    }

    @Fact
    func FunctionLiteral_UseBeforeAssignmentIsStillReported() {
        // The shared lowering feeds definite assignment, so a use of a captured
        // local that is not yet assigned inside the literal is still reported.
        let (diagnostics, counters) = Bind(`
func Main() int32 {
    var c chan[int32]
    let f = func() int32 { return <-c }
    c = chan[int32](1)
    c <- 1
    return f()
}
`)
        Assert.True(counters.LambdaLowerings > 0)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0522")
    }

    @Fact
    func IteratorBody_YieldFactIsWalkedOncePerBodyObject() {
        let (diagnostics, counters) = Bind(`
func Count(n int32) sequence[int32] {
    for var i = 0; i < n; i++ {
        yield i
    }
}
func Main() int32 {
    var total = 0
    for x in Count(3) { total += x }
    return total
}
`)
        Assert.Empty(diagnostics)
        Assert.True(counters.YieldReuses > 0)
        Assert.True(counters.YieldWalks > 0)
    }

    private data struct Counters(
        LambdaLowerings int64,
        LambdaLoweringReuses int64,
        YieldWalks int64,
        YieldReuses int64
    )

    shared {
        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Counters Counters) {
            using let measurements = CompilationMeasurements.Start("issue5131")
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            let program = Binder.BindProgram(globalScope)
            return (
                program.Diagnostics.ToImmutableArray(),
                Counters(
                    measurements.GetCounter("bodyfacts.lambda-lowerings"),
                    measurements.GetCounter("bodyfacts.lambda-lowering-reuses"),
                    measurements.GetCounter("bodyfacts.yield-walks"),
                    measurements.GetCounter("bodyfacts.yield-reuses")
                )
            )
        }
    }
}
