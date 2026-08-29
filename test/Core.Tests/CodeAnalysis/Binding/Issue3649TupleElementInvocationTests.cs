// <copyright file="Issue3649TupleElementInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3649 — direct invocation of a function-typed tuple element:
/// <c>t.f(10)</c>. Witness of discrimination: before the fix the call binder
/// treated <c>t.f</c> as a METHOD lookup on the tuple's CLR backing
/// (<c>ValueTuple</c>) and reported "Cannot find function f", even though
/// reading the element (<c>let a = t.f</c>) and invoking the local worked.
/// </summary>
public class Issue3649TupleElementInvocationTests
{
    [Fact]
    public void NamedElement_DirectInvocation_IssueRepro()
    {
        var result = EmittedOracle.Evaluate(@"
let t = (f: (x int32) -> x + 1, g: () -> 5)
let r2 = t.f(10)
r2
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void NamedElements_DirectInvocation_BothElements()
    {
        var result = EmittedOracle.Evaluate(@"
let t = (f: (x int32) -> x + 1, g: () -> 5)
t.f(10) + t.g()
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void PositionalItemSelector_DirectInvocation()
    {
        var result = EmittedOracle.Evaluate(@"
let t = ((x int32) -> x + 1, (x int32) -> x * 2)
t.Item1(10) + t.Item2(3)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(17, result.Value);
    }

    [Fact]
    public void NamedElement_DeclaredTupleType_DirectInvocation()
    {
        var result = EmittedOracle.Evaluate(@"
func mk() (f (int32) -> int32, g () -> int32) {
    return ((x int32) -> x - 1, () -> 7)
}

let t = mk()
t.f(10) + t.g()
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void NestedAccess_TupleMemberOfClass_DirectInvocation()
    {
        var result = EmittedOracle.Evaluate(@"
class Holder {
    var t (f (int32) -> int32, n int32)
}

let x = Holder()
x.t = ((v int32) -> v + 1, 0)
x.t.f(10)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void DelegateTypedElement_NamedSelector_DirectInvocation()
    {
        var result = EmittedOracle.Evaluate(@"
let t (h System.Func[int32, int32], n int32) = ((x int32) -> x + 1, 0)
t.h(10)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void DelegateTypedElement_ItemSelector_DirectInvocation()
    {
        var result = EmittedOracle.Evaluate(@"
let t (System.Func[int32, int32], int32) = ((x int32) -> x + 1, 0)
t.Item1(10)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void ElementRead_ThenInvoke_StillWorks()
    {
        var result = EmittedOracle.Evaluate(@"
let t = (f: (x int32) -> x + 1, g: () -> 5)
let a = t.f
a(10)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void NonCallableNamedElement_ReportsNotAFunction()
    {
        var result = EmittedOracle.Evaluate(@"
let t = (f: 41, g: 0)
t.f(1)
");
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }
}
