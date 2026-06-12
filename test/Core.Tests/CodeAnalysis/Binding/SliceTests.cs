// <copyright file="SliceTests.cs" company="GSharp">
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
/// Phase 3.A.2 — variable-length slice types <c>[]T</c>, composite
/// literals, indexing, and the <c>len</c> / <c>cap</c> / <c>append</c>
/// intrinsics.
/// </summary>
public class SliceTests
{
    [Fact]
    public void SliceLiteral_BindsAndEvaluates()
    {
        var result = Evaluate("var xs = []int32{10, 20, 30}\nxs[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void TypedSliceDeclaration_Works()
    {
        var result = Evaluate("var xs []int32 = []int32{1, 2, 3}\nxs[0] + xs[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void Len_OnSlice_ReturnsCount()
    {
        var result = Evaluate("var xs = []int32{1, 2, 3, 4}\nlen(xs)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void Len_OnArray_ReturnsLength()
    {
        var result = Evaluate("var xs = [3]int32{1, 2, 3}\nlen(xs)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Len_OnString_ReturnsLength()
    {
        var result = Evaluate("len(\"hello\")");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void Cap_OnSlice_AliasesLen()
    {
        var result = Evaluate("var xs = []int32{1, 2, 3}\ncap(xs)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Cap_OnString_Diagnosed()
    {
        var diagnostics = Bind("cap(\"x\")\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("'cap' cannot"));
    }

    [Fact]
    public void Append_GrowsSliceByOne()
    {
        var result = Evaluate("var xs = []int32{1, 2}\nxs = append(xs, 3)\nlen(xs)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Append_PreservesExistingElements()
    {
        var result = Evaluate("var xs = []int32{10, 20}\nxs = append(xs, 30)\nxs[0] + xs[1] + xs[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(60, result.Value);
    }

    [Fact]
    public void Append_OnArray_Diagnosed()
    {
        var diagnostics = Bind("var xs = [2]int32{1, 2}\nappend(xs, 3)\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("'append' cannot"));
    }

    [Fact]
    public void EmptySliceLiteral_AppendWorks()
    {
        var result = Evaluate("var xs = []int32{}\nxs = append(xs, 7)\nxs[0]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void StringSlice_AppendWorks()
    {
        var result = Evaluate("var ns = []string{\"a\"}\nns = append(ns, \"b\")\nns[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("b", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        // ADR-0083 / issue #723: every gated built-in (len / cap / append /
        // delete) used in the test sources is intentional, so prepend the
        // gate import here rather than duplicating it across every literal
        // string. This mirrors the helper-level mitigation #722 applied for
        // the channel-cluster tests.
        var tree = SyntaxTree.Parse(SourceText.From("import Gsharp.Extensions.Go\n" + source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => Evaluate(source).Diagnostics;
}
