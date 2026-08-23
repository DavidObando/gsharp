// <copyright file="Issue3501RefKindFunctionLiteralTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3501 Track A2: function literals and native function types carry
/// ADR-0060 <c>ref</c>/<c>out</c>/<c>in</c> parameters with the same
/// semantics as declared functions. <c>System.Func</c>/<c>Action</c> cannot
/// represent by-ref type arguments, so such shapes bind to a
/// compiler-synthesized delegate (one per distinct shape, emitted through
/// the ADR-0059 named-delegate path); previously a ref-kind literal without
/// a named-delegate target failed with a same-display GS0155.
/// </summary>
public class Issue3501RefKindFunctionLiteralTests
{
    [Fact]
    public void RefLiteral_InfersSynthesizedDelegate_AndMutatesThroughRef()
    {
        var source = @"
func Run() int32 {
    let bump = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OutAndInLiterals_WorkThroughInferredTypes()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(49, result.Value);
    }

    [Fact]
    public void RefFunctionTypeClause_InParameterPosition_AcceptsLiteralArgument()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void RefFunctionTypeClause_InReturnPosition_RoundTrips()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullableRefFunctionType_AssignsAndInvokesWithAssertion()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void SelfReferencingRefLiteral_Recurses()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void SameShape_UnifiesToOneSynthesizedDelegate()
    {
        // Two spellings of the same shape are the same symbol within one
        // compile pass, so a literal bound through one clause assigns to a
        // slot declared through the other.
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NamedDelegateTarget_StillBindsDirectly()
    {
        // The delegate declaration is spelled AFTER `func Run` because a
        // void-returning `delegate func(...)` greedily consumes a following
        // `func` keyword as its return-type clause (pre-existing parse
        // greediness, unrelated to this issue).
        var source = @"
func Run() int32 {
    let bump BumpShape = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()

type BumpShape = delegate func(ref n int32)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }
}
