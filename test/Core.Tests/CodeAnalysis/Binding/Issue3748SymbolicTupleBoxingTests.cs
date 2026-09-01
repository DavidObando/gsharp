// <copyright file="Issue3748SymbolicTupleBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3748: a tuple always boxes implicitly to <c>object</c> /
/// <c>object?</c>. <c>TupleTypeSymbol.BuildClrType</c> deliberately leaves
/// <c>ClrType</c> null whenever an element requires symbolic projection — most
/// commonly a nullable-reference element such as <c>(A int32, B string?)</c> —
/// and the general CLR-backed boxing rule in <c>Conversion</c> requires a
/// non-null source <c>ClrType</c>, so those tuples were rejected with
/// <c>GS0155 Cannot convert type '(…)' to 'object?'</c> in every
/// <c>object</c>-typed position.
/// </summary>
/// <remarks>
/// The reporting issue framed this as named-tuple-plus-lambda; it is neither.
/// Witness of discrimination: the same shape without the nullable element
/// (<c>(A int32, B string)</c>) boxed fine, an <em>unnamed</em> tuple with a
/// nullable element failed identically, and the lambda position was incidental.
/// The trigger is a null <c>ClrType</c> on the tuple, not its element names.
/// </remarks>
public class Issue3748SymbolicTupleBoxingTests
{
    [Fact]
    public void NamedTupleWithNullableElement_BoxesToNullableObject()
    {
        var result = EmittedOracle.Evaluate(@"
let t (A int32, B string?) = (1, ""x"")
let o object? = t
o!!.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("(1, x)", result.Value);
    }

    [Fact]
    public void UnnamedTupleWithNullableElement_BoxesToObject()
    {
        var result = EmittedOracle.Evaluate(@"
let t (int32, string?) = (2, ""y"")
let o object = t
o.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("(2, y)", result.Value);
    }

    [Fact]
    public void NamedTupleWithNullableElement_BoxesInFuncReturnPosition()
    {
        var result = EmittedOracle.Evaluate(@"
func Run(name string) (ExitCode int32, Stdout string?, Stderr string?) {
    return (ExitCode: 0, Stdout: name, Stderr: nil)
}

func Box() object? {
    return Run(""x"")
}

Box()!!.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("(0, x, )", result.Value);
    }

    [Fact]
    public void NamedTupleWithNullableElement_BoxesInLambdaReturnPosition()
    {
        // The reporting site (test/Compiler.Tests/IlVerifierTests.cs:206):
        // `Assert.Throws<XunitException>(() => IlVerifier.RunProcess(…))`.
        var result = EmittedOracle.Evaluate(@"
func Run(name string) (ExitCode int32, Stdout string?, Stderr string?) {
    return (ExitCode: 9, Stdout: name, Stderr: nil)
}

func Invoke(f (() -> object?)) object? -> f()

Invoke(func () object? { return Run(""z"") })!!.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("(9, z, )", result.Value);
    }

    [Fact]
    public void NamedTupleWithNullableElement_BoxesInArgumentPosition()
    {
        var result = EmittedOracle.Evaluate(@"
import System

func Describe(value object?) string -> string.Format(""{0}"", value)

let t (A int32, B string?) = (4, ""q"")
Describe(t)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("(4, q)", result.Value);
    }
}
