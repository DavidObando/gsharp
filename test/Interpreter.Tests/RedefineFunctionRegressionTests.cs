// <copyright file="RedefineFunctionRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Regression coverage for issue #1404: redefining a function in the REPL must
/// surface a diagnostic instead of tearing down the host with an exception.
/// </summary>
public class RedefineFunctionRegressionTests
{
    [Fact]
    public void EvaluateForRepl_RedefiningFunction_DoesNotThrow()
    {
        var repl = new GSharpRepl();
        repl.EvaluateForRepl("func foo() int32 { return 1 }");

        var ex = Record.Exception(() => repl.EvaluateForRepl("func foo() int32 { return 2 }"));

        Assert.Null(ex);
    }

    [Fact]
    public void EvaluateForRepl_SecondSimpleExpression_StillEvaluates()
    {
        var repl = new GSharpRepl();
        repl.EvaluateForRepl("func foo() int32 { return 1 }");
        repl.EvaluateForRepl("func foo() int32 { return 2 }");

        var result = repl.EvaluateForRepl("1 + 2");

        Assert.True(result.Success);
        Assert.Equal("3", result.Value?.ToString());
    }

    [Fact]
    public void EvaluateForRepl_InvalidInput_ReportsErrorWithoutThrowing()
    {
        var repl = new GSharpRepl();
        var result = repl.EvaluateForRepl("1 +");
        Assert.False(result.Success);
        Assert.NotEmpty(result.Diagnostics);
    }
}
