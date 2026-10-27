// <copyright file="GSharpReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

open class GSharpReplTests {
    @Theory
    @InlineData("span")
    @InlineData("slice")
    @InlineData("array")
    func EarlierIndexedValueWinsOverNativeAlias(name string) {
        using let engine = EmittedSessionEngine()
        let declaration = engine.Evaluate("let " + name + " = []string{\"x\", \"hello\"}")
        Assert.False(declaration.HasError, string.Join("; ", declaration.Diagnostics))
        let result = engine.Evaluate("let i = 1\n" + name + "[i].Length")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(5, result.Value)
    }

    @Theory
    @InlineData("typeof(bytestring) == typeof($$bytestring)", true)
    @InlineData("let value bytestring = bytestring{Value: 7}\nvalue.Value", int32(7))
    func EarlierUserTypeWinsOverNativeAlias(submission string, expected object) {
        using let engine = EmittedSessionEngine()
        let declaration = engine.Evaluate("class bytestring { var Value int32 }")
        Assert.False(declaration.HasError, string.Join("; ", declaration.Diagnostics))
        let result = engine.Evaluate(submission)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("func bytestring(value object) int32 -> 42")
    @InlineData("let bytestring (object) -> int32 = (value object) -> 42")
    func EarlierCallableWinsOverNativeConversion(declaration string) {
        using let engine = EmittedSessionEngine()
        let first = engine.Evaluate(declaration)
        Assert.False(first.HasError, string.Join("; ", first.Diagnostics))
        let result = engine.Evaluate("bytestring(b\"x\")")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(42, result.Value)
    }

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
