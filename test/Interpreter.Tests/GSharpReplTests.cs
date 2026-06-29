// <copyright file="GSharpReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class GSharpReplTests
{
    [Fact]
    public void Evaluate_SimpleExpression_ReturnsValue()
    {
        var cell = new SessionEngine().Evaluate("1 + 2");
        Assert.False(cell.HasError);
        Assert.Equal("3", cell.Value?.ToString());
    }

    [Fact]
    public void Evaluate_StringLiteral_ReturnsValue()
    {
        var cell = new SessionEngine().Evaluate("\"hello\"");
        Assert.Contains("hello", cell.Value?.ToString());
    }

    [Fact]
    public void Evaluate_InvalidInput_ProducesDiagnostics()
    {
        var cell = new SessionEngine().Evaluate("1 +");
        Assert.True(cell.HasError);
        Assert.NotEmpty(cell.Diagnostics);
    }

    [Fact]
    public void IsComplete_OpenExpression_False() => Assert.False(SessionEngine.IsComplete("func f() {"));
}
