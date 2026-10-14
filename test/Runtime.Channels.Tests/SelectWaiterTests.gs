// <copyright file="SelectWaiterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D8 protocol facts for (cref:SelectWaiter) that are
/// deterministic: arm selection, value transfer, generation guard, loser
/// deregistration, closed-channel arms, cancellation with and without a
/// `cancelled` arm, task arms, foreign-arm readiness, and gate ordering.
/// @remarks Discrimination witnesses (ADR-0154, mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/SelectWaiter.cs`): removing the
/// generation increment from `Begin` breaks (cref:TryClaim_StaleGeneration_IsRejected);
/// deleting the `Deregister` loop from `Return` breaks
/// (cref:Return_DeregistersLosers); sorting gates descending (or not
/// at all) breaks (cref:CollectGates_SortsAscendingById_AndDedupes);
/// completing the waiter with the cancellation without the CAS breaks
/// (cref:Cancellation_AfterClaim_IsIgnored).
open class SelectWaiterTests {
    @Fact
    async func ReadyArm_UnderLocks_CompletesSynchronously_WithValue() {
        let a = Chan[int32](1)
        let b = Chan[int32](1)
        b.TrySend(42)
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](a, 0)
        w.AddReceive[int32](b, 1)
        let wait = w.WaitAsync()
        Assert.True(wait.IsCompletedSuccessfully)
        Assert.Equal(1, await wait)
        Assert.True(w.Ok)
        Assert.False(w.NeedsReprobe)
        Assert.Equal(42, w.TakeValue[int32]())
        w.Return()
        Assert.Equal(0, a.RegisteredWaiterCount)
        Assert.Equal(0, b.RegisteredWaiterCount)
    }

    @Fact
    async func ParkedThenSend_WinsThatArm_AndTransfersExactlyOnce() {
        let a = Chan[string]()
        let b = Chan[string]()
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[string](a, 0)
        w.AddReceive[string](b, 1)
        let wait = w.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        Assert.Equal(1, a.RegisteredWaiterCount)
        Assert.Equal(1, b.RegisteredWaiterCount)
        // The send commits directly into the select — the value is never buffered.
        Assert.True(b.TrySend("hello"))
        Assert.Equal(1, await wait.WaitAsync(SelectWaiterTests.Timeout))
        Assert.Equal("hello", w.TakeValue[string]())
        Assert.Equal(0, b.Length())
        w.Return()
        Assert.Equal(0, a.RegisteredWaiterCount)
    }

    @Fact
    async func Return_DeregistersLosers() {
        let a = Chan[int32]()
        let b = Chan[int32]()
        let c = Chan[int32]()
        let w = SelectWaiter.Rent(3, CancellationToken.None)
        w.AddReceive[int32](a, 0)
        w.AddReceive[int32](b, 1)
        w.AddSend[int32](c, 5, 2)
        let wait = w.WaitAsync().AsTask()
        Assert.Equal(1, a.RegisteredWaiterCount)
        Assert.Equal(1, b.RegisteredWaiterCount)
        Assert.Equal(1, c.RegisteredWaiterCount)
        a.TrySend(1)
        Assert.Equal(0, await wait.WaitAsync(SelectWaiterTests.Timeout))
        w.Return()
        Assert.Equal(0, a.RegisteredWaiterCount + b.RegisteredWaiterCount + c.RegisteredWaiterCount)
    }

    @Fact
    async func TryClaim_StaleGeneration_IsRejected() {
        let ch = Chan[int32]()
        let w = SelectWaiter.Rent(1, CancellationToken.None)
        w.AddReceive[int32](ch, 0)
        let wait = w.WaitAsync().AsTask()
        let stale = w.Generation
        ch.TrySend(1)
        Assert.Equal(0, await wait.WaitAsync(SelectWaiterTests.Timeout))
        w.Return()
        let reused = SelectWaiter.Rent(1, CancellationToken.None)
        Assert.Same(w, reused)
        Assert.Equal(stale + int64(1), reused.Generation)
        Assert.False(reused.TryClaim(stale, 7))
        Assert.True(reused.TryClaim(reused.Generation, 3))
        Assert.False(reused.TryClaim(reused.Generation, 4))
        reused.Return()
    }

    @Fact
    async func SendArm_OnRendezvous_HandsValueToArrivingReceiver() {
        let ch = Chan[int32]()
        let never = Chan[int32]()
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddSend[int32](ch, 77, 0)
        w.AddReceive[int32](never, 1)
        let wait = w.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        let received = await ch.ReceiveAsync().AsTask().WaitAsync(SelectWaiterTests.Timeout)
        Assert.Equal(77, received.Value)
        Assert.Equal(0, await wait.WaitAsync(SelectWaiterTests.Timeout))
        w.Return()
    }

    @Fact
    async func ClosedChannel_ReceiveArm_FiresWithZero_AndOkFalse() {
        let ch = Chan[int32]()
        let never = Chan[int32]()
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](ch, 0)
        w.AddReceive[int32](never, 1)
        let wait = w.WaitAsync().AsTask()
        ch.Close()
        Assert.Equal(0, await wait.WaitAsync(SelectWaiterTests.Timeout))
        Assert.False(w.Ok)
        Assert.Equal(0, w.TakeValue[int32]())
        w.Return()
        // Already closed at probe time: same outcome, synchronously.
        let w2 = SelectWaiter.Rent(1, CancellationToken.None)
        w2.AddReceive[int32](ch, 0)
        let wait2 = w2.WaitAsync()
        Assert.True(wait2.IsCompletedSuccessfully)
        Assert.False(w2.Ok)
        w2.Return()
    }

    @Fact
    async func ClosedChannel_SendArm_Throws() {
        let ch = Chan[int32]()
        let never = Chan[int32]()
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddSend[int32](ch, 1, 0)
        w.AddReceive[int32](never, 1)
        let wait = w.WaitAsync().AsTask()
        ch.Close()
        await Assert.ThrowsAsync[ChannelClosedException](
            func () Task {
                return wait.WaitAsync(SelectWaiterTests.Timeout)
            }
        )
        w.Return()
        let w2 = SelectWaiter.Rent(1, CancellationToken.None)
        w2.AddSend[int32](ch, 1, 0)
        await Assert.ThrowsAsync[ChannelClosedException](async () -> await w2.WaitAsync())
        w2.Return()
    }

    @Fact
    async func Cancellation_WithoutCancelledArm_Throws_AndDeregisters() {
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource()
        let w = SelectWaiter.Rent(1, cts.Token)
        w.AddReceive[int32](ch, 0)
        let wait = w.WaitAsync().AsTask()
        cts.Cancel()
        await Assert.ThrowsAsync[OperationCanceledException](
            func () Task {
                return wait.WaitAsync(SelectWaiterTests.Timeout)
            }
        )
        w.Return()
        Assert.Equal(0, ch.RegisteredWaiterCount)
    }

    @Fact
    async func Cancellation_WithCancelledArm_SelectsIt() {
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource()
        let w = SelectWaiter.Rent(2, cts.Token)
        w.AddReceive[int32](ch, 0)
        w.AddCancelled(1)
        let wait = w.WaitAsync().AsTask()
        cts.Cancel()
        Assert.Equal(1, await wait.WaitAsync(SelectWaiterTests.Timeout))
        w.Return()
        // Already cancelled at probe time: taken synchronously.
        let w2 = SelectWaiter.Rent(2, cts.Token)
        w2.AddReceive[int32](ch, 0)
        w2.AddCancelled(1)
        let wait2 = w2.WaitAsync()
        Assert.True(wait2.IsCompletedSuccessfully)
        Assert.Equal(1, await wait2)
        w2.Return()
    }

    @Fact
    async func Cancellation_AfterClaim_IsIgnored() {
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource()
        let w = SelectWaiter.Rent(1, cts.Token)
        w.AddReceive[int32](ch, 0)
        let wait = w.WaitAsync().AsTask()
        Assert.True(ch.TrySend(9))
        cts.Cancel()
        Assert.Equal(0, await wait.WaitAsync(SelectWaiterTests.Timeout))
        Assert.Equal(9, w.TakeValue[int32]())
        w.Return()
    }

    @Fact
    async func TaskArm_Wins_WithResult_AndFaultPropagates() {
        let never = Chan[int32]()
        let tcs = TaskCompletionSource[string]()
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](never, 0)
        w.AddTask(tcs.Task, 1)
        let wait = w.WaitAsync().AsTask()
        tcs.SetResult("done")
        Assert.Equal(1, await wait.WaitAsync(SelectWaiterTests.Timeout))
        Assert.Equal("done", w.TakeValue[string]())
        w.Return()
        let faulted = TaskCompletionSource[string]()
        let w2 = SelectWaiter.Rent(2, CancellationToken.None)
        w2.AddReceive[int32](never, 0)
        w2.AddTask(faulted.Task, 1)
        let wait2 = w2.WaitAsync().AsTask()
        faulted.SetException(InvalidOperationException("boom"))
        let ex = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return wait2.WaitAsync(SelectWaiterTests.Timeout)
            }
        )
        Assert.Equal("boom", ex.Message)
        w2.Return()
        // Completed before registration: synchronous.
        let w3 = SelectWaiter.Rent(1, CancellationToken.None)
        w3.AddTask(Task.FromResult(5), 0)
        Assert.Equal(0, await w3.WaitAsync())
        Assert.Equal(5, w3.TakeValue[int32]())
        w3.Return()
    }

    @Fact
    async func ForeignArm_SignalsReadiness_WithNeedsReprobe() {
        let foreign = Channel.CreateBounded[int32](1)
        let never = Chan[int32]()
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](foreign, 0)
        w.AddReceive[int32](never, 1)
        let wait = w.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        await foreign.Writer.WriteAsync(3)
        Assert.Equal(0, await wait.WaitAsync(SelectWaiterTests.Timeout))
        Assert.True(w.NeedsReprobe)
        w.Return()
        // Re-probe finds the item.
        Assert.True(foreign.Reader.TryRead(out var v))
        Assert.Equal(3, v)
        // Closed foreign channel: the arm fires closed (no re-probe needed).
        foreign.Writer.Complete()
        let w2 = SelectWaiter.Rent(1, CancellationToken.None)
        w2.AddReceive[int32](foreign, 0)
        Assert.Equal(0, await w2.WaitAsync())
        Assert.False(w2.Ok)
        Assert.False(w2.NeedsReprobe)
        w2.Return()
    }

    @Fact
    async func NilArms_AreDisabled() {
        let ch = Chan[int32](1)
        ch.TrySend(1)
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](default(Channel[int32]?), 0)
        w.AddSend[int32](default(ChannelWriter[int32]?), 5, 1)
        w.AddReceive[int32](ch, 2)
        Assert.Equal(1, w.ArmCount)
        Assert.Equal(2, await w.WaitAsync())
        w.Return()
    }

    @Fact
    func CollectGates_SortsAscendingById_AndDedupes() {
        let first = Chan[int32]()
        let second = Chan[int32]()
        let third = Chan[string]()
        Assert.True(first.Id < second.Id && second.Id < third.Id)
        let w = SelectWaiter.Rent(4, CancellationToken.None)
        w.AddReceive[string](third, 0)
        w.AddReceive[int32](second, 1)
        w.AddReceive[int32](first, 2)
        w.AddSend[int32](second, 1, 3)
        let gates = w.CollectGates()
        Assert.Equal(
            []int64{first.Id, second.Id, third.Id},
            gates.Select((g(Order int64, Gate object)) -> g.Order).ToArray()
        )
        w.Return()
    }

    @Fact
    async func SameChannel_ReceiveAndSend_ArmsCoexist() {
        // The same channel in two arms locks once and both register.
        let ch = Chan[int32](1)
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](ch, 0)
        w.AddSend[int32](ch, 1, 1)
        Assert.Equal(1, await w.WaitAsync())
        Assert.Equal(1, ch.Length())
        w.Return()
    }

    @Fact
    func SelectRandom_Shuffle_IsAPermutation_AndReseedIsReproducible() {
        SelectRandom.Reseed(1234)
        let a = SelectRandom.Shuffle(10).ToArray()
        Assert.Equal(Enumerable.Range(0, 10), a.OrderBy((x int32) -> x))
        SelectRandom.Reseed(1234)
        let b = SelectRandom.Shuffle(10).ToArray()
        Assert.Equal(a, b)
        Assert.Empty(SelectRandom.Shuffle(0).ToArray())
        let seen = HashSet[int32]()
        for var i = 0; i < 1000; i++ {
            seen.Add(SelectRandom.Next(3))
        }
        Assert.Equal([]int32{0, 1, 2}, seen.OrderBy((x int32) -> x))
    }

    @Fact
    func TryNow_WithCancelledArm_TakesItWhenAlreadyCancelled() {
        // The `default` path probes without registering or parking. An
        // already-cancelled context is a ready arm — Go's `ctx.Done()` is a
        // ready channel — so `default` must not win over it (ADR-0174 D8).
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource()
        cts.Cancel()
        let w = SelectWaiter.Rent(2, cts.Token)
        w.AddReceive[int32](ch, 0)
        w.AddCancelled(1)
        Assert.Equal(1, w.TryNow())
        w.Return()
    }

    @Fact
    func TryNow_WithCancelledArm_ReportsNothingReadyWhileLive() {
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource()
        let w = SelectWaiter.Rent(2, cts.Token)
        w.AddReceive[int32](ch, 0)
        w.AddCancelled(1)
        Assert.Equal(-1, w.TryNow())
        w.Return()
    }

    @Fact
    func TryNow_PrefersAReadyChannel_OverAnAlreadyCancelledContext() {
        // Deliberate, and the same rule the parking path already follows: the
        // gated channel arms are probed first, and cancellation is consulted
        // only when nothing else can make progress. A select that can do its
        // work does it rather than bail out.
        using let cts = CancellationTokenSource()
        cts.Cancel()
        for var i = 0; i < 200; i++ {
            let ch = Chan[int32](1)
            ch.Writer.TryWrite(7)
            let w = SelectWaiter.Rent(2, cts.Token)
            w.AddReceive[int32](ch, 0)
            w.AddCancelled(1)
            Assert.Equal(0, w.TryNow())
            w.Return()
        }
    }

    @Fact
    async func Select_LosingTaskArm_DoesNotRetainTheWaiter() {
        // A task arm that loses must have its continuation removed, or a
        // long-running task keeps the (pooled) waiter alive and later completes
        // into a waiter that has been reused. `TaskArm.Deregister` cancels the
        // continuation's registration; this reads the field that holds it.
        let slot = typeof(Task).GetField("m_continuationObject", BindingFlags.NonPublic | BindingFlags.Instance)
        Assert.NotNull(slot)
        let pending = TaskCompletionSource[int32](TaskCreationOptions.RunContinuationsAsynchronously)
        let ready = Chan[int32](1)
        ready.Writer.TryWrite(7)
        let waiter = SelectWaiter.Rent(2, CancellationToken.None)
        waiter.AddReceive[int32](ready, 0)
        waiter.AddTask(pending.Task, 1)
        Assert.Equal(0, await waiter.WaitAsync().AsTask().WaitAsync(SelectWaiterTests.Timeout))
        waiter.Return()
        // The continuation is removed asynchronously by the cancellation the
        // arm's Deregister raises; give it a bounded moment to settle.
        let deadline = DateTime.UtcNow + SelectWaiterTests.Timeout
        while slot!!.GetValue(pending.Task) != nil && DateTime.UtcNow < deadline {
            await Task.Delay(10)
        }
        Assert.Null(slot!!.GetValue(pending.Task))
        pending.TrySetResult(1)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
