// <copyright file="Issue3501RefKindFunctionLiteralTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501 Track A2: function literals and native function types carry
/// ADR-0060 `ref`/`out`/`in` parameters with the same
/// semantics as declared functions. `System.Func`/`Action` cannot
/// represent by-ref type arguments, so such shapes bind to a
/// compiler-synthesized delegate (one per distinct shape, emitted through
/// the ADR-0059 named-delegate path); previously a ref-kind literal without
/// a named-delegate target failed with a same-display GS0155.
open class Issue3501RefKindFunctionLiteralTests {
    @Fact
    func RefLiteral_InfersSynthesizedDelegate_AndMutatesThroughRef() {
        let source = `
func Run() int32 {
    let bump = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func OutAndInLiterals_WorkThroughInferredTypes() {
        let source = `
func Run() int32 {
    let tryGet = func(out v int32) bool {
        v = 7
        return true
    }
    var total = 0
    if tryGet(out var got) {
        total += got
    }
    let reader = func(in v int32) int32 {
        return v * 2
    }
    var src = 21
    total += reader(&src)
    return total
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(49, result.Value)
    }

    @Fact
    func RefFunctionTypeClause_InParameterPosition_AcceptsLiteralArgument() {
        let source = `
func apply(f (ref int32) -> void) int32 {
    var x = 41
    f(ref x)
    return x
}

func Run() int32 {
    return apply(func(ref n int32) {
        n = n + 1
    })
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func RefFunctionTypeClause_InReturnPosition_RoundTrips() {
        let source = `
func makeDouble() (ref int32) -> void {
    return func(ref n int32) {
        n = n * 2
    }
}

func Run() int32 {
    let f = makeDouble()
    var x = 21
    f(ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableRefFunctionType_AssignsAndInvokesWithAssertion() {
        let source = `
func Run() int32 {
    var acc ((ref int32) -> void)? = nil
    acc = func(ref n int32) {
        n = n + 10
    }
    var y = 1
    acc!!(ref y)
    return y
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func SelfReferencingRefLiteral_Recurses() {
        let source = `
func Run() int32 {
    let countdown = func(ref n int32) {
        if n > 0 {
            n = n - 1
            countdown(ref n)
        }
    }
    var x = 5
    countdown(ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(0, result.Value)
    }

    @Fact
    func SameShape_UnifiesToOneSynthesizedDelegate() {
        // Two spellings of the same shape are the same symbol within one
        // compile pass, so a literal bound through one clause assigns to a
        // slot declared through the other.
        let source = `
func apply(f (ref int32) -> void, seed int32) int32 {
    var x = seed
    f(ref x)
    return x
}

func Run() int32 {
    let g ((ref int32) -> void) = func(ref n int32) {
        n = n + 1
    }
    return apply(g, 41)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NamedDelegateTarget_StillBindsDirectly() {
        // The delegate declaration is spelled AFTER `func Run` because a
        // void-returning `delegate func(...)` greedily consumes a following
        // `func` keyword as its return-type clause (pre-existing parse
        // greediness, unrelated to this issue).
        let source = `
func Run() int32 {
    let bump BumpShape = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()

delegate BumpShape(ref n int32);
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }
}
