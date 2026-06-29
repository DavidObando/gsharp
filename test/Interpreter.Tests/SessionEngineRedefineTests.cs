// <copyright file="SessionEngineRedefineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class SessionEngineRedefineTests
{
    [Fact]
    public void Redefining_Function_DoesNotThrow()
    {
        var engine = new SessionEngine();
        engine.Evaluate("func Fib(x int) long { return if x <= 0 { 0 } else if x == 1 { 1 } else { Fib(x-1)-Fib(x-2) } }");
        var second = engine.Evaluate("func Fib(x int) long { return if x <= 0 { 0 } else if x == 1 { 1 } else { Fib(x-1)+Fib(x-2) } }");
        Assert.NotNull(second);
    }

    [Fact]
    public void EvaluateException_BecomesErrorCell_NotCrash()
    {
        var engine = new SessionEngine();
        var cell = engine.Evaluate("func Fib(x int) long { return Fib(x-1)+Fib(x-2) }");
        engine.Evaluate("func Fib(x int) long { return x }");
        Assert.NotNull(cell);
    }
}
