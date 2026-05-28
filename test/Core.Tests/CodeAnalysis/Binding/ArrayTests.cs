// <copyright file="ArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.A.1 / 3.A.3 — fixed-length arrays, composite literals,
/// read and write indexing.
/// </summary>
public class ArrayTests
{
    [Fact]
    public void ArrayLiteral_BindsAndEvaluates()
    {
        var result = Evaluate("var xs = [3]int32{10, 20, 30}\nlet y = xs[1]\ny");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void ArrayLiteral_LengthMismatch_Diagnosed()
    {
        var diagnostics = Bind("var xs = [3]int32{1, 2}\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("3 initialisers"));
    }

    [Fact]
    public void TypedArrayDeclaration_Works()
    {
        var result = Evaluate("var xs [3]int32 = [3]int32{1, 2, 3}\nxs[0] + xs[2]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void IndexAssignment_UpdatesElement()
    {
        var result = Evaluate("var xs = [3]int32{1, 2, 3}\nxs[1] = 99\nxs[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void IndexExpression_OnNonArray_Diagnosed()
    {
        var diagnostics = Bind("let s = \"hello\"\nlet c = s[0]\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("not indexable"));
    }

    [Fact]
    public void StringArray_Works()
    {
        var result = Evaluate("var names = [2]string{\"a\", \"b\"}\nnames[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("b", result.Value);
    }

    [Fact]
    public void BoolArray_Works()
    {
        var result = Evaluate("var flags = [2]bool{true, false}\nflags[0]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void InvalidElementType_Diagnosed()
    {
        var diagnostics = Bind("var xs = [3]NotAType{1, 2, 3}\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("doesn't exist"));
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
