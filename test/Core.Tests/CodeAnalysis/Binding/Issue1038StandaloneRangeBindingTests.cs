// <copyright file="Issue1038StandaloneRangeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1038: binder/interpreter coverage for the standalone range value
/// (<c>let r = 1..3</c>) and its use as an index argument (<c>a[r]</c>). The
/// four open forms bind to a constructed <c>System.Range</c>; indexing an array
/// or string by a range value slices it. A leading <c>^</c> at the start of a
/// standalone range reports GS0410.
/// </summary>
public class Issue1038StandaloneRangeBindingTests
{
    [Fact]
    public void StandaloneRange_IsSystemRangeTyped()
    {
        var result = Evaluate("let r = 1..3\nr.GetType().FullName");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("System.Range", result.Value);
    }

    [Fact]
    public void RangeValue_IndexesArray_ClosedRange()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet r = 1..3\nlet ys = xs[r]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void RangeValue_IndexesArray_OpenLowerBound()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet r = ..2\nlet ys = xs[r]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(30, result.Value);
    }

    [Fact]
    public void RangeValue_IndexesArray_OpenUpperBound()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet r = 3..\nlet ys = xs[r]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(90, result.Value);
    }

    [Fact]
    public void RangeValue_IndexesArray_FullRange()
    {
        var result = Evaluate("var xs = [3]int32{7, 8, 9}\nlet r = ..\nlet ys = xs[r]\nys[0] + ys[1] + ys[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(24, result.Value);
    }

    [Fact]
    public void RangeValue_FromEndUpperBound_IndexesArray()
    {
        // xs[1..^1] keeps indices 1, 2, 3 (drops the last).
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet r = 1..^1\nlet ys = xs[r]\nys.Length * 1000 + ys[0] + ys[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((3 * 1000) + 20 + 40, result.Value);
    }

    [Fact]
    public void RangeValue_IndexesString()
    {
        var result = Evaluate("let s = \"hello world\"\nlet r = 0..5\ns[r]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello", result.Value);
    }

    [Fact]
    public void InlineParenthesizedRange_IndexesArray()
    {
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet ys = xs[(1..3)]\nys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void RangeBindsLooserThanAdditive()
    {
        // 1+1..2+2 == 2..4 -> xs[2..4] == {30, 40}.
        var result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet r = 1+1..2+2\nlet ys = xs[r]\nys.Length * 1000 + ys[0] + ys[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((2 * 1000) + 30 + 40, result.Value);
    }

    [Fact]
    public void LeadingFromEndMarker_ReportsGs0410()
    {
        var diagnostics = GetDiagnostics("let r = ^1..3\nr");
        Assert.Contains(diagnostics, d => d.Id == "GS0410");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
        => Evaluate(source).Diagnostics;
}
