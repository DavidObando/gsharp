// <copyright file="Issue3639TupleArrowElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3639 — end-to-end coverage for tuple types with parenthesized
/// arrow-function elements: <c>((int32) -&gt; int32, (int32) -&gt; int32)</c>.
/// Witness of discrimination: before the fix every declared type below was a
/// GS0005 parse error (&quot;Unexpected token &lt;CommaToken&gt;&quot;) because the parser
/// committed the leading <c>((</c> to the ADR-0137 parenthesized-arrow form.
/// </summary>
public class Issue3639TupleArrowElementTests
{
    [Fact]
    public void TupleOfArrowFunctions_DeclaredReturnType_DeconstructAndInvoke()
    {
        var result = EmittedOracle.Evaluate(@"
func mk() ((int32) -> int32, (int32) -> int32) {
    return ((x int32) -> x + 1, (x int32) -> x * 2)
}

let (a, b) = mk()
a(1) + b(3)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void TupleOfZeroArgArrowFunctions_DeclaredReturnType()
    {
        var result = EmittedOracle.Evaluate(@"
func mk() (() -> int32, () -> int32) {
    return (() -> 10, () -> 32)
}

let (a, b) = mk()
a() + b()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TupleWithArrowElement_LocalDeclaration_MixedWithPlainType()
    {
        var result = EmittedOracle.Evaluate(@"
let t ((int32) -> int32, int32) = ((x int32) -> x * x, 6)
let (f, n) = t
f(n)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(36, result.Value);
    }

    [Fact]
    public void NamedTupleElements_WithArrowElementTypes_AccessByName()
    {
        var result = EmittedOracle.Evaluate(@"
func mk() (f (int32) -> int32, g () -> int32) {
    return ((x int32) -> x - 1, () -> 7)
}

let t = mk()
let f = t.f
let g = t.g
f(10) + g()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(16, result.Value);
    }
}
