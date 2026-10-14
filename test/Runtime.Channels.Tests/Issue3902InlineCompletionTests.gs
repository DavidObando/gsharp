// <copyright file="Issue3902InlineCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import SystemObject = System.Object
import Xunit

/// Issue #3902 (H1) / ADR-0174 gate G6: a hand-off completes its waiter's
/// continuation on the publishing thread when the inline budget allows,
/// instead of queueing a thread-pool work item for another thread to steal.
/// @remarks The performance case is measured by the concurrency benchmark. These tests
/// exist for the four ways inline completion can be WRONG, each of which is
/// silent under every pre-existing test.
/// 1. A blocking channel operation is what `lock { ch <- v }` compiles to. Monitor is reentrant, so an
/// inline continuation would run inside the caller's lock and observe mutual exclusion it does not hold
/// — (cref:BlockingSend_DoesNotRunAContinuationInsideTheCallersLock).
/// 2. The continuation runs while `SetResult` is still on the stack, so a node returned to its pool
/// from inside `GetResult` is re-rented within the publisher's own frame —
/// (cref:InlineContinuation_MayReRentTheSameNode).
/// 3. Nesting is bounded, or a chain of hand-offs grows the stack per link —
/// (cref:DeepHandoffChain_CompletesWithoutExhaustingTheStack).
/// 4. A cancellation callback must not run user code on the cancelling thread —
/// (cref:CancelledSelect_DoesNotRunItsContinuationOnTheCancellingThread).
open class Issue3902InlineCompletionTests {
    @Fact
    async func BlockingSend_DoesNotRunAContinuationInsideTheCallersLock() {
        let gate = SystemObject()
        let ch = Chan[int32](0)
        var observedInsideLock = false
        let receiverReady = SemaphoreSlim(0)
        let receiver = Task.Run(
            async () -> {
                receiverReady.Release()
                await ch.ReceiveValueAsync().AsTask().ConfigureAwait(false)
                // If the sender published inline, this continuation is running on
                // the sender's stack, inside its lock.
                observedInsideLock = Monitor.IsEntered(gate)
            }
        )
        await receiverReady.WaitAsync(Issue3902InlineCompletionTests.Timeout)
        await Task.Delay(50)
        lock gate {
            ChannelOps.Send(ch, 1, default(CancellationToken))
        }
        await receiver.WaitAsync(Issue3902InlineCompletionTests.Timeout)
        Assert.False(
            observedInsideLock,
            "a receive continuation ran inside the sending thread's monitor. A blocking channel " +
                "operation is a `lock { ch <- v }` body, and Monitor's reentrancy makes that silently " +
                "wrong (issue #3902 H1)."
        )
    }

    @Fact
    async func InlineContinuation_MayReRentTheSameNode() {
        // The continuation runs before SetResult has returned, and consuming the
        // result returns the node to the channel's single-slot cache. Re-renting
        // it from inside that frame is the sharpest version of the reuse, and it
        // must produce a fresh version token rather than replay the old result.
        let ch = Chan[int32](0)
        let results = [8]int32
        let consumer = Task.Run(
            async () -> {
                for var i = 0; i < results.Length; i++ {
                    results[i] = await ch.ReceiveValueAsync().ConfigureAwait(false)
                }
            }
        )
        for var i = 0; i < results.Length; i++ {
            await ch.SendAsync(i + 1).AsTask().WaitAsync(Issue3902InlineCompletionTests.Timeout)
        }
        await consumer.WaitAsync(Issue3902InlineCompletionTests.Timeout)
        Assert.Equal([]int32{1, 2, 3, 4, 5, 6, 7, 8}, results)
    }

    @Fact
    async func DeepHandoffChain_CompletesWithoutExhaustingTheStack() {
        // Each link's receive completes the previous link's send, so an
        // unbounded inline budget would nest one frame per link. The gate's
        // stack test: it must complete, not merely avoid crashing.
        const Links = 10_000
        let ch = Chan[int32](0)
        var total = 0L
        let consumer = Task.Run(
            async () -> {
                for var i = 0; i < Links; i++ {
                    total += int64(await ch.ReceiveValueAsync().ConfigureAwait(false))
                }
            }
        )
        for var i = 1; i <= Links; i++ {
            await ch.SendAsync(i).AsTask().WaitAsync(Issue3902InlineCompletionTests.Timeout)
        }
        await consumer.WaitAsync(Issue3902InlineCompletionTests.Timeout)
        Assert.Equal(int64(Links) * (int64(Links) + 1L) / int64(2), total)
    }

    @Fact
    async func CancelledSelect_DoesNotRunItsContinuationOnTheCancellingThread() {
        using let cts = CancellationTokenSource()
        let ch = Chan[int32](0)
        var cancellingThread = 0
        var continuationThread = 0
        let w = SelectWaiter.Rent(1, cts.Token)
        w.AddReceive(ch, 0)
        let wait = w.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        let observer = wait.ContinueWith(
            (_ Task[int32]) -> (continuationThread = Environment.CurrentManagedThreadId),
            TaskContinuationOptions.ExecuteSynchronously
        )
        cancellingThread = Environment.CurrentManagedThreadId
        cts.Cancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return wait.WaitAsync(Issue3902InlineCompletionTests.Timeout)
            }
        )
        await observer.WaitAsync(Issue3902InlineCompletionTests.Timeout)
        w.Return()
        Assert.NotEqual(cancellingThread, continuationThread)
    }

    @Fact
    async func HandoffStillDelivers_WhenTheBudgetIsExhausted() {
        // Whatever the budget decides, the value must arrive. Drive far more
        // hand-offs than the depth limit through one channel.
        let ch = Chan[int32](0)
        var seen = 0
        let consumer = Task.Run(
            async () -> {
                while true {
                    let (value, ok) = await ch.ReceiveTupleAsync().ConfigureAwait(false)
                    if !ok {
                        return
                    }
                    seen += value
                }
            }
        )
        for var i = 0; i < 200; i++ {
            await ch.SendAsync(1).AsTask().WaitAsync(Issue3902InlineCompletionTests.Timeout)
        }
        ch.Close()
        await consumer.WaitAsync(Issue3902InlineCompletionTests.Timeout)
        Assert.Equal(200, seen)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(30)
    }
}
