// <copyright file="BlockingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading.Tasks
import Xunit

/// ADR-0174 D4: the root bridge returns a completed result without allocating and blocks on an
/// incomplete one.
open class BlockingTests {
    @Fact
    func Wait_CompletedValueTask_ReturnsResult() {
        Assert.Equal(7, Blocking.Wait(ValueTask[int32](7)))
        Blocking.Wait(ValueTask.CompletedTask)
    }

    @Fact
    func Wait_IncompleteValueTask_BlocksUntilCompletion() {
        let tcs = TaskCompletionSource[int32](TaskCreationOptions.RunContinuationsAsynchronously)
        let _ = Task.Run(
            async () -> {
                await Task.Delay(20)
                tcs.SetResult(42)
            }
        )
        Assert.Equal(42, Blocking.Wait(ValueTask[int32](tcs.Task)))
    }

    @Fact
    func Wait_FaultedValueTask_RethrowsTheFault() {
        let faulted = ValueTask[int32](Task.FromException[int32](InvalidOperationException("boom")))
        Assert.Throws[InvalidOperationException](
            func () object? {
                return Blocking.Wait(faulted)
            }
        )
    }
}
