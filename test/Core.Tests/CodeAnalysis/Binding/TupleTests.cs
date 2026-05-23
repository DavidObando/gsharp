// <copyright file="TupleTests.cs" company="GSharp">
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
/// Phase 4.5 — tuple types <c>(T1, T2, ...)</c>, tuple literals, and tuple
/// element access via <c>.Item1</c>..<c>.ItemN</c> (interpreter-only).
/// </summary>
public class TupleTests
{
    [Fact]
    public void TupleLiteral_ItemAccess_ReturnsFirstElement()
    {
        var result = Evaluate(@"
let p = (1, ""x"")
p.Item1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void TupleLiteral_ItemAccess_ReturnsSecondElement()
    {
        var result = Evaluate(@"
let p = (1, ""x"")
p.Item2
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("x", result.Value);
    }

    [Fact]
    public void TupleTypeClause_OnLocal_BindsAndEvaluates()
    {
        var result = Evaluate(@"
let p (int, string) = (7, ""hi"")
p.Item1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void FunctionReturningTuple_AccessElement()
    {
        var result = Evaluate(@"
func pair() (int, int) {
    return (3, 4)
}
let q = pair()
q.Item2
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void TupleAccess_OutOfRange_ReportsDiagnostic()
    {
        var source = @"
let p = (1, ""x"")
p.Item3
";
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Deconstruction_BindsNamedLocals()
    {
        var result = Evaluate(@"
let (a, b) = (10, ""ok"")
a
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Deconstruction_AccessesSecondElement()
    {
        var result = Evaluate(@"
let (a, b) = (10, ""ok"")
b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }

    [Fact]
    public void MultiReturn_PackedIntoTuple_DeconstructAtCallSite()
    {
        var result = Evaluate(@"
func divmod(a int, b int) (int, int) {
    return a / b, a % b
}
let (q, r) = divmod(10, 3)
q
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void MultiReturn_RemainderAccessible()
    {
        var result = Evaluate(@"
func divmod(a int, b int) (int, int) {
    return a / b, a % b
}
let (q, r) = divmod(10, 3)
r
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
