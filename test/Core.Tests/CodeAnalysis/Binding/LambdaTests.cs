// <copyright file="LambdaTests.cs" company="GSharp">
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
/// Phase 4.7 — first-class function types (<c>func(T) R</c>), function literals,
/// indirect calls, and by-value closure capture (interpreter-only).
/// </summary>
public class LambdaTests
{
    [Fact]
    public void FunctionLiteral_DirectInvocation_ReturnsResult()
    {
        var result = Evaluate(@"
let add = func(a int32, b int32) int32 { return a + b }
add(2, 3)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void FunctionTypeClause_OnLocal_AcceptsMatchingLiteral()
    {
        var result = Evaluate(@"
let add func(int32, int32) int32 = func(a int32, b int32) int32 { return a + b }
add(4, 5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void Closure_CapturesLocalByValue()
    {
        var result = Evaluate(@"
let n = 7
let f = func() int32 { return n + 1 }
f()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void Closure_ValueCaptureSnapshotsAtLiteralEvaluation()
    {
        // Captured *locals* are snapshotted at literal-evaluation time. Globals
        // are intentionally not captured (read live at call time). Use a helper
        // function to exercise local-capture semantics.
        var result = Evaluate(@"
func makeReader() func() int32 {
    var n = 1
    let f = func() int32 { return n }
    n = 99
    return f
}
let r = makeReader()
r()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void FunctionLiteral_VoidReturn_Works()
    {
        var result = Evaluate(@"
let noop = func() { }
noop()
1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void IndirectCall_WrongArgCount_ReportsDiagnostic()
    {
        var result = Evaluate(@"
let add = func(a int32, b int32) int32 { return a + b }
add(1)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void MethodGroup_NamedFunction_ConvertsToNativeFuncType()
    {
        // Issue #324: a bare function name in a value context expecting a
        // compatible delegate converts to a method group — no lambda wrapper.
        var result = Evaluate(@"
func inc(x int32) int32 { return x + 1 }
let f func(int32) int32 = inc
f(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void MethodGroup_NamedFunction_PassedAsCallbackArgument()
    {
        // Issue #324: a method group flows into a `func(...)`-typed parameter.
        var result = Evaluate(@"
func twice(x int32) int32 { return x * 2 }
func apply(g func(int32) int32, v int32) int32 { return g(v) }
apply(twice, 21)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
