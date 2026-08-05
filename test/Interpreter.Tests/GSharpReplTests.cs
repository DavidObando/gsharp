// <copyright file="GSharpReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class GSharpReplTests
{
    [Fact]
    public void Snapshot_DisplaysConstructedSourceGenericType()
    {
        using var engine = new EmittedSessionEngine();

        Assert.False(engine.Evaluate("class Box[T] {}").HasError);
        Assert.False(engine.Evaluate("let box = Box[int32]()").HasError);

        var variable = Assert.Single(engine.Snapshot().Variables);
        Assert.Contains("Box[int32]", variable.Display);
    }

    [Fact]
    public void Evaluate_SimpleExpression_ReturnsValue()
    {
        using var engine = new EmittedSessionEngine();
        var cell = engine.Evaluate("1 + 2");
        Assert.False(cell.HasError);
        Assert.Equal("3", cell.Value?.ToString());
    }

    [Fact]
    public void Evaluate_StringLiteral_ReturnsValue()
    {
        using var engine = new EmittedSessionEngine();
        var cell = engine.Evaluate("\"hello\"");
        Assert.Contains("hello", cell.Value?.ToString());
    }

    [Fact]
    public void Evaluate_InvalidInput_ProducesDiagnostics()
    {
        using var engine = new EmittedSessionEngine();
        var cell = engine.Evaluate("1 +");
        Assert.True(cell.HasError);
        Assert.NotEmpty(cell.Diagnostics);
    }

    [Fact]
    public void IsComplete_OpenExpression_False() => Assert.False(EmittedSessionEngine.IsComplete("func f() {"));
}
