// <copyright file="Adr0174SuspendFuncSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

/// ADR-0174 D4 across REPL cells: a suspending function declared in one cell
/// (declared with `suspend`, or inferred from a channel operation) is a
/// `[Suspending]` `ValueTask` method in that cell's assembly; a later
/// cell reads the label from metadata, sees the logical return type, and
/// completes the call — implicitly awaited inside a suspending caller, blocked
/// at the cell's root.
class Adr0174SuspendFuncSessionTests {
    @Fact
    func DeclaredSuspendFunc_IsCallableFromALaterCell() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `var ch = chan[int32](2)
suspend func take() int32 {
    return <-ch
}`)
        AssertOk(engine, "ch <- 4\nch <- 5")
        let result = engine.Evaluate("take() + take()")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(9, result.Value)
    }

    @Fact
    func InferredSuspendingFunc_IsCallableFromALaterCell_AndFromASuspendingCaller() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `var ch = chan[int32](2)
func take() int32 {
    return <-ch
}`)
        AssertOk(engine, `func twice() int32 {
    return take() + take()
}`)
        AssertOk(engine, "ch <- 20\nch <- 22")
        let result = engine.Evaluate("twice()")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ScopeAndGo_AcrossCells_Join() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `var ch = chan[int32](3)
func send(v int32) {
    ch <- v
}`)
        AssertOk(engine, `scope {
    go send(1)
    go send(2)
    go send(3)
}`)
        let result = engine.Evaluate("<-ch + <-ch + <-ch")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(6, result.Value)
    }

    shared {
        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        }
    }
}
