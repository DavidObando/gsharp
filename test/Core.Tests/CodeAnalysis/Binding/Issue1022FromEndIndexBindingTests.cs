// <copyright file="Issue1022FromEndIndexBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1022: binder/interpreter coverage for the from-end index marker
/// <c>^n</c>. A bare <c>a[^n]</c> reads <c>length - n</c>; from-end bounds in a
/// range compute the concrete offset at lowering time. Regression checks keep
/// the one's-complement / XOR meanings of <c>^</c> intact.
/// </summary>
public class Issue1022FromEndIndexBindingTests
{
    [Fact]
    public void SingleFromEndIndex_LastElement()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nxs[^1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void SingleFromEndIndex_NthFromEnd()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nxs[^2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(40, result.Value);
    }

    [Fact]
    public void FromEndUpperBound_DropsLast()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[1..^1]\nys[0] + ys[ys.Length - 1]");
        Assert.Empty(result.Diagnostics);

        // ys = {20, 30, 40}; first + last = 60.
        Assert.Equal(60, result.Value);
    }

    [Fact]
    public void FromEndUpperBound_OpenLower_DropsLastThree()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[..^3]\nys.Length * 1000 + ys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);

        // ys = {10, 20}; len 2 -> 2030.
        Assert.Equal(2030, result.Value);
    }

    [Fact]
    public void FromEndLowerBound_OpenUpper_LastTwo()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[^2..]\nys.Length * 1000 + ys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);

        // ys = {40, 50}; len 2 -> 2090.
        Assert.Equal(2090, result.Value);
    }

    [Fact]
    public void StringSlice_FromEndUpperBound()
    {
        var result = Evaluate("let s = \"abcdef\"\ns[..^3]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("abc", result.Value);
    }

    [Fact]
    public void StringSlice_FromEndBothEnds()
    {
        var result = Evaluate("let s = \"abcdef\"\ns[1..^1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("bcde", result.Value);
    }

    [Fact]
    public void OnesComplement_StillEvaluates()
    {
        var result = Evaluate("^0");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-1, result.Value);
    }

    [Fact]
    public void Xor_StillEvaluates()
    {
        var result = Evaluate("6 ^ 3");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
