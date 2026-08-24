// <copyright file="Issue3501FunctionLiteralSelfReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3501 Track A2: a <c>let</c>/<c>var</c>-bound function literal can
/// reference its own name inside its body — the binding is declared from the
/// literal's signature (or the explicit type clause) BEFORE the body binds,
/// so recursion works through the captured variable. This is the G#
/// local-function idiom; previously the body-site name lookup failed with
/// GS0130.
/// </summary>
public class Issue3501FunctionLiteralSelfReferenceTests
{
    [Fact]
    public void LetBoundLiteral_CanRecurse()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(120, result.Value);
    }

    [Fact]
    public void ExplicitTypeClause_LetBoundLiteral_CanRecurse()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(55, result.Value);
    }

    [Fact]
    public void TopLevelLetBoundLiteral_CanRecurse()
    {
        var source = @"
let fib = func(n int32) int32 {
    if n <= 1 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}

fib(10)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(55, result.Value);
    }

    [Fact]
    public void VarBoundLiteral_RecursionFollowsReassignment()
    {
        // Recursion goes through the variable's cell, not a snapshot: after
        // `f` is reassigned, the ORIGINAL literal's self-call observes the
        // new value — the same semantics C# gives `Func<int,int> f = ...`
        // built via the null-then-assign idiom.
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void Literal_CapturesOuterLocalAndSelf()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void GenericLocalFunction_CanRecurse()
    {
        var source = @"
func Run() int32 {
    let depth[T] = func(v T, n int32) int32 {
        if n <= 0 {
            return 0
        }
        return depth[T](v, n - 1) + 1
    }
    return depth[string](""x"", 4)
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void AsyncLiteral_CanRecurse()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(5, result.Value);
    }
}
