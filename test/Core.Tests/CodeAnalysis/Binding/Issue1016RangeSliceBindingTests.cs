// <copyright file="Issue1016RangeSliceBindingTests.cs" company="GSharp">
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
/// Issue #1016: binder/interpreter coverage for the range/slice operator. The
/// closed and open forms bind against arrays, slices, and strings and evaluate
/// to the expected slice; a non-sliceable target reports GS0392.
/// </summary>
public class Issue1016RangeSliceBindingTests
{
    [Fact]
    public void ArraySlice_ClosedRange_Evaluates()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[1..3]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void ArraySlice_OpenLowerBound_Evaluates()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[..2]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(30, result.Value);
    }

    [Fact]
    public void ArraySlice_OpenUpperBound_Evaluates()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[3..]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(90, result.Value);
    }

    [Fact]
    public void ArraySlice_FullRange_Evaluates()
    {
        var result = Evaluate("var xs = [3]int32{7, 8, 9}\nlet ys = xs[..]\nys[0] + ys[1] + ys[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(24, result.Value);
    }

    [Fact]
    public void StringSlice_ClosedRange_Evaluates()
    {
        var result = Evaluate("let s = \"hello world\"\nlet h = s[0..5]\nh");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello", result.Value);
    }

    [Fact]
    public void StringSlice_OpenUpperBound_Evaluates()
    {
        var result = Evaluate("let s = \"hello world\"\nlet w = s[6..]\nw");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("world", result.Value);
    }

    [Fact]
    public void NonSliceableTarget_ReportsGs0392()
    {
        var diagnostics = Bind("import System.Collections.Generic\nlet m = Dictionary[string, int32]()\nlet bad = m[\"a\"..\"b\"]\n");
        Assert.Contains(diagnostics, d => d.Id == "GS0392");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => Evaluate(source).Diagnostics;
}
