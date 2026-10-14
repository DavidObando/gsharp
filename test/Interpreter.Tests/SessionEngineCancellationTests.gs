// <copyright file="SessionEngineCancellationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System
import System.Threading
import System.Threading.Tasks
import Xunit

open class SessionEngineCancellationTests {
    @Fact
    async func EvaluateAsync_CancelledBeforeCommit_DoesNotAppendCellOrMutateState() {
        using let engine = EmittedSessionEngine()
        using let cts = CancellationTokenSource()
        await cts.CancelAsync()
        await Assert.ThrowsAsync[OperationCanceledException](
            func () Task {
                return engine.EvaluateAsync("let x = 1", cts.Token)
            }
        )
        Assert.Empty(engine.Cells)
        // Session state must be untouched: a later, uncancelled evaluation referencing "x"
        // should fail to resolve it, proving the cancelled submission never committed.
        let next = engine.Evaluate("x")
        Assert.True(next.HasError)
    }

    @Fact
    async func EvaluateAsync_NotCancelled_CommitsCellNormally() {
        using let engine = EmittedSessionEngine()
        let cell = await engine.EvaluateAsync("1 + 1", CancellationToken.None)
        Assert.Single(engine.Cells)
        Assert.False(cell.HasError)
    }
}
