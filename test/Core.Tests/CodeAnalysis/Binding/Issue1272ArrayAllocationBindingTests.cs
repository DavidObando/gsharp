// <copyright file="Issue1272ArrayAllocationBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1272: Emitted-oracle coverage for array allocation binding.
/// </summary>
public class Issue1272ArrayAllocationBindingTests
{
    [Fact]
    public void ConstantLength_ZeroInitialised()
    {
        var result = Evaluate("var xs = [3]int32\nxs[0] + xs[1] + xs[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void RuntimeLength_AllElementsZero()
    {
        var result = Evaluate("let n = 4\nvar xs = [n]int32\nxs.Length + xs[0] + xs[3]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void EmptyInitializerSpelling_ZeroInitialised()
    {
        var result = Evaluate("let n = 2\nvar xs = [n]int32{}\nxs.Length + xs[0] + xs[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void RuntimeLength_MutationReadBack()
    {
        var result = Evaluate("let n = 3\nvar xs = [n]int32\nxs[1] = 42\nxs[0] + xs[1] + xs[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void RuntimeLength_ResultIsSlice()
    {
        var result = Evaluate("let n = 5\nvar xs = [n]int32\nxs.Length");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void LiteralFormUnchanged_LengthMismatchReportsGs0115()
    {
        var diagnostics = Bind("var xs = [5]int32{1, 2, 3}\n");
        Assert.Contains(diagnostics, d => d.Id == "GS0115");
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => Evaluate(source).Diagnostics;
}
