// <copyright file="Issue1129StringIndexerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1129: indexing a <c>string</c> with <c>s[i]</c> was rejected with
/// GS0116 "Type 'string' is not indexable." In C#/.NET <c>string</c> exposes
/// <c>char this[int]</c> (<c>get_Chars</c>), so <c>s[i]</c> yields the
/// <c>char</c> at that position. The binder now maps <c>string[int]</c> to a
/// <c>BoundIndexExpression</c> with a <c>char</c> result; string WRITE
/// (<c>s[i] = c</c>) remains rejected because .NET strings are immutable.
/// </summary>
public class Issue1129StringIndexerBinderTests
{
    [Fact]
    public void StringIndex_ReadByConstant_NoDiagnostics()
    {
        // Acceptance criteria #1: the repro binds with no diagnostics.
        var result = Evaluate("let s = \"ABCD\"\ns[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal('B', result.Value);
    }

    [Fact]
    public void StringIndex_ReadByConstant_FirstChar()
    {
        var result = Evaluate("let s = \"ABCD\"\nint32(s[0])");
        Assert.Empty(result.Diagnostics);

        // 'A' = 65
        Assert.Equal(65, result.Value);
    }

    [Fact]
    public void StringIndex_ReadByVariable_NoDiagnostics()
    {
        // Acceptance criteria #3: indexing with a non-constant int variable.
        var result = Evaluate("let s = \"ABCD\"\nlet i = 2\ns[i]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal('C', result.Value);
    }

    [Fact]
    public void StringIndex_ResultIsChar()
    {
        // The bound element/result type must be `char` so downstream
        // numeric/char handling (e.g. int32(c)) works.
        var diagnostics = GetDiagnostics(
            "package p\nclass C {\n    func F(s string) char {\n        return s[0]\n    }\n}");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StringIndex_ResultUsedAsChar_AssignsToCharTyped()
    {
        var diagnostics = GetDiagnostics(
            "package p\nclass C {\n    func F(s string, i int32) char {\n        return s[i]\n    }\n}");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StringIndex_WriteStillRejected()
    {
        // Acceptance criteria #4: .NET strings are immutable, so s[i] = c
        // must still report GS0116.
        var diagnostics = GetDiagnostics(
            "package p\nclass C {\n    func F(s string) {\n        s[0] = 'x'\n    }\n}");
        Assert.NotEmpty(diagnostics);
        Assert.Contains(diagnostics, d => d.Contains("not indexable"));
    }

    [Fact]
    public void StringSlice_StillWorks()
    {
        // Acceptance criteria #5: no regression to string slicing.
        var result = Evaluate("let s = \"abcdef\"\ns[1..3]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("bc", result.Value);
    }

    [Fact]
    public void StringFromEndIndex_StillWorks()
    {
        // Acceptance criteria #5: no regression to from-end indexing on string.
        var result = Evaluate("let s = \"ABCD\"\ns[^1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal('D', result.Value);
    }

    [Fact]
    public void StringLength_StillWorks()
    {
        // Acceptance criteria #5: no regression to s.Length.
        var result = Evaluate("let s = \"ABCD\"\ns.Length");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ArrayIndex_StillWorks()
    {
        // Acceptance criteria #5: no regression to array indexing.
        var result = Evaluate("var xs = [3]int32{10, 20, 30}\nxs[1]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(20, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static string[] GetDiagnostics(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics.Where(d => d.IsError).Select(d => d.Message).ToArray();
    }
}
