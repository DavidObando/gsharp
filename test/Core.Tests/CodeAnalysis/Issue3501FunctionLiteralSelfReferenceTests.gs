// <copyright file="Issue3501FunctionLiteralSelfReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501 Track A2: a `let`/`var`-bound function literal can
/// reference its own name inside its body — the binding is declared from the
/// literal's signature (or the explicit type clause) BEFORE the body binds,
/// so recursion works through the captured variable. This is the G#
/// local-function idiom; previously the body-site name lookup failed with
/// GS0130.
open class Issue3501FunctionLiteralSelfReferenceTests {
    @Fact
    func LetBoundLiteral_CanRecurse() {
        let source = `
func Run() int32 {
    let fact = func(n int32) int32 {
        if n <= 1 {
            return 1
        }
        return n * fact(n - 1)
    }
    return fact(5)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(120, result.Value)
    }

    @Fact
    func ExplicitTypeClause_LetBoundLiteral_CanRecurse() {
        let source = `
func Run() int32 {
    let fib ((int32) -> int32) = func(n int32) int32 {
        if n <= 1 {
            return n
        }
        return fib(n - 1) + fib(n - 2)
    }
    return fib(10)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(55, result.Value)
    }

    @Fact
    func TopLevelLetBoundLiteral_CanRecurse() {
        let source = `
let fib = func(n int32) int32 {
    if n <= 1 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}

fib(10)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(55, result.Value)
    }

    @Fact
    func VarBoundLiteral_RecursionFollowsReassignment() {
        // Recursion goes through the variable's cell, not a snapshot: after
        // `f` is reassigned, the ORIGINAL literal's self-call observes the
        // new value — the same semantics C# gives `Func<int,int> f = ...`
        // built via the null-then-assign idiom.
        let source = `
func Run() int32 {
    var f = func(n int32) int32 {
        if n <= 0 {
            return 0
        }
        return f(n - 1)
    }
    let original = f
    f = func(n int32) int32 {
        return 100
    }
    return original(1)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(100, result.Value)
    }

    @Fact
    func Literal_CapturesOuterLocalAndSelf() {
        let source = `
func Run() int32 {
    var offset = 10
    let sum = func(n int32) int32 {
        if n <= 0 {
            return offset
        }
        return n + sum(n - 1)
    }
    return sum(3)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(16, result.Value)
    }

    @Fact
    func GenericLocalFunction_CanRecurse() {
        let source = `
func Run() int32 {
    let depth[T] = func(v T, n int32) int32 {
        if n <= 0 {
            return 0
        }
        return depth[T](v, n - 1) + 1
    }
    return depth[string]("x", 4)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(4, result.Value)
    }

    @Fact
    func AsyncLiteral_CanRecurse() {
        let source = `
func Run() int32 {
    let depth = async func(n int32) int32 {
        if n <= 0 {
            return 0
        }
        return await depth(n - 1) + 1
    }
    return depth(5).Result
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }
}
