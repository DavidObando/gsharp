// <copyright file="ExceptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
/// Phase 3.D — try / catch / finally / throw statements.
/// </summary>
public class ExceptionTests
{
    [Fact]
    public void TryFinally_RunsFinally()
    {
        var source = @"
var trace = """"
try {
    trace = trace + ""t""
} finally {
    trace = trace + ""f""
}
trace
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("tf", result.Value);
    }

    [Fact]
    public void TryCatch_CatchesBclException()
    {
        var source = @"
import System
var caught = ""before""
try {
    var n = Int32.Parse(""not a number"")
} catch (e Exception) {
    caught = ""caught""
}
caught
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("caught", result.Value);
    }

    [Fact]
    public void TryCatchFinally_CatchAndFinallyBothRun()
    {
        var source = @"
import System
var trace = """"
try {
    var n = Int32.Parse(""bad"")
} catch (e Exception) {
    trace = trace + ""c""
} finally {
    trace = trace + ""f""
}
trace
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("cf", result.Value);
    }

    [Fact]
    public void TryWithoutCatchOrFinally_Diagnosed()
    {
        var diagnostics = Bind("try { var x = 1 }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("catch") || d.Message.Contains("finally"));
    }

    [Fact]
    public void Throw_NonExceptionDiagnosed()
    {
        var diagnostics = Bind("throw 42\n");
        Assert.NotEmpty(diagnostics);
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
