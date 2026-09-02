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
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.A.2 — variable-length slice types <c>[]T</c>, composite
/// literals, and indexing. ADR-0174 D13 retired the <c>len</c> /
/// <c>cap</c> / <c>append</c> built-ins: a slice's length is <c>.Length</c>,
/// the growable shape is <c>List[T]</c> + <c>Add</c>, and the retired
/// spellings report GS0566 naming that replacement.
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
        var result = Evaluate("var xs = []int32{1, 2, 3, 4}\nxs.Length");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void Len_OnArray_ReturnsLength()
    {
        var result = Evaluate("var xs = [3]int32{1, 2, 3}\nxs.Length");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Len_OnString_ReturnsLength()
    {
        var result = Evaluate("\"hello\".Length");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void Cap_IsRetired_ReportsGS0566()
    {
        // ADR-0174 D13: `cap` has no replacement — a slice is a fixed CLR
        // array whose capacity is its length.
        var diagnostics = Bind("var xs = []int32{1, 2, 3}\ncap(xs)\n");
        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains("xs.Length", diagnostic.Message);
    }

    [Fact]
    public void Append_IsRetired_ReportsGS0566_NamingListAdd()
    {
        var diagnostics = Bind("var xs = []int32{1, 2}\nxs = append(xs, 3)\n");
        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains("List[T]", diagnostic.Message);
        Assert.Contains("xs.Add(3)", diagnostic.Message);
    }

    [Fact]
    public void GrowableShape_IsListAdd()
    {
        var result = Evaluate("import System.Collections.Generic\nvar xs = List[int32]()\nxs.Add(10)\nxs.Add(20)\nxs.Add(30)\nxs[0] + xs[1] + xs[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(60, result.Value);
    }

    [Fact]
    public void StringSlice_LiteralIndexes()
    {
        var result = Evaluate("var ns = []string{\"a\", \"b\"}\nns[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("b", result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => Evaluate(source).Diagnostics;
}
