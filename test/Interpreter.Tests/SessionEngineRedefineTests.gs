// <copyright file="SessionEngineRedefineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

open class SessionEngineRedefineTests {
    @Fact
    func Redefining_Function_DoesNotThrow() {
        using let engine = EmittedSessionEngine()
        engine.Evaluate(
            "func Fib(x int) long { return if x <= 0 { 0 } else if x == 1 { 1 } else { Fib(x-1)-Fib(x-2) } }"
        )
        let second = engine.Evaluate(
            "func Fib(x int) long { return if x <= 0 { 0 } else if x == 1 { 1 } else { Fib(x-1)+Fib(x-2) } }"
        )
        Assert.NotNull(second)
    }

    @Fact
    func EvaluateException_BecomesErrorCell_NotCrash() {
        using let engine = EmittedSessionEngine()
        let cell = engine.Evaluate("func Fib(x int) long { return Fib(x-1)+Fib(x-2) }")
        engine.Evaluate("func Fib(x int) long { return x }")
        Assert.NotNull(cell)
    }
}
