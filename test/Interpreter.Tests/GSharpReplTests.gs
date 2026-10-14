// <copyright file="GSharpReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

open class GSharpReplTests {
    @Fact
    func Snapshot_DisplaysConstructedSourceGenericType() {
        using let engine = EmittedSessionEngine()
        Assert.False(engine.Evaluate("class Box[T] {}").HasError)
        Assert.False(engine.Evaluate("let box = Box[int32]()").HasError)
        let variable = Assert.Single(engine.Snapshot().Variables)
        Assert.Contains("Box[int32]", variable.Display)
    }

    @Fact
    func Evaluate_SimpleExpression_ReturnsValue() {
        using let engine = EmittedSessionEngine()
        let cell = engine.Evaluate("1 + 2")
        Assert.False(cell.HasError)
        Assert.Equal("3", cell.Value?.ToString())
    }

    @Fact
    func Evaluate_StringLiteral_ReturnsValue() {
        using let engine = EmittedSessionEngine()
        let cell = engine.Evaluate("\"hello\"")
        Assert.Contains("hello", cell.Value?.ToString())
    }

    @Fact
    func Evaluate_InvalidInput_ProducesDiagnostics() {
        using let engine = EmittedSessionEngine()
        let cell = engine.Evaluate("1 +")
        Assert.True(cell.HasError)
        Assert.NotEmpty(cell.Diagnostics)
    }

    @Fact
    func IsComplete_OpenExpression_False() -> Assert.False(EmittedSessionEngine.IsComplete("func f() {"))
}
