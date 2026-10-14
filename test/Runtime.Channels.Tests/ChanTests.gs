// <copyright file="ChanTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Linq
import System.Runtime.ExceptionServices
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D1/D3 semantics of (cref:Chan{T}): the three-state receive
/// encoding, FIFO buffering, close/dispose, cancellation linearization, and
/// the happens-before guarantee.
/// @remarks Discrimination witnesses (ADR-0154, product mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/Chan{T}.cs`): returning
/// `(true, false)` for an open empty channel breaks
/// (cref:TryReceive_ThreeStates_AreEncodedNormatively); routing
/// `Dispose` to `Close` breaks (cref:Dispose_AfterClose_DoesNotThrow);
/// returning the buffered count from `Capacity` (or the capacity from
/// `Length()`) breaks (cref:Length_And_Capacity_Differ_WhenPartiallyFilled);
/// restoring a `ChannelClosedException`-based closed-receive breaks
/// (cref:ClosedReceive_RaisesNoFirstChanceException); letting the
/// cancellation callback complete an already-committed node breaks
/// (cref:ReceiveAsync_CancelRacingSend_NeverLosesValue); publishing the
/// node's result before the value deposit breaks
/// (cref:HappensBefore_FieldWrittenBeforeSend_IsVisibleAfterReceive).
open class ChanTests {
    @Fact
    func TryReceive_ThreeStates_AreEncodedNormatively() {
        let ch = Chan[int32](2)
        // (false, _): nothing available right now, channel open.
        Assert.False(ch.TryReceive(out _, out _))
        // (true, true): a value.
        Assert.True(ch.TrySend(7))
        Assert.True(ch.TryReceive(out var value, out var ok))
        Assert.True(ok)
        Assert.Equal(7, value)
        // (true, false): closed and drained, value is the zero.
        ch.Close()
        Assert.True(ch.TryReceive(out value, out ok))
        Assert.False(ok)
        Assert.Equal(0, value)
    }

    @Fact
    func BufferedChannel_IsFifo_AndTrySendFailsWhenFull() {
        let ch = Chan[int32](3)
        Assert.True(ch.TrySend(1))
        Assert.True(ch.TrySend(2))
        Assert.True(ch.TrySend(3))
        Assert.False(ch.TrySend(4))
        Assert.Equal(3, ch.Length())
        let drained = List[int32]()
        while ch.TryReceive(out var v, out var ok) && ok {
            drained.Add(v)
        }
        Assert.Equal([]int32{1, 2, 3}, drained)
        Assert.Equal(0, ch.Length())
    }

    @Fact
    func Length_And_Capacity_Differ_WhenPartiallyFilled() {
        let ch = Chan[int32](8)
        ch.TrySend(1)
        ch.TrySend(2)
        ch.TrySend(3)
        Assert.Equal(3, ch.Length())
        Assert.Equal(8, ch.Capacity)
        Assert.False(ch.IsUnbounded)
    }

    @Fact
    func Unbounded_AcceptsManySends_WithoutBlocking() {
        let ch = Chan.Unbounded[int32]()
        Assert.True(ch.IsUnbounded)
        Assert.Equal(int32.MaxValue, ch.Capacity)
        for var i = 0; i < 10_000; i++ {
            Assert.True(ch.TrySend(i))
        }
        Assert.Equal(10_000, ch.Length())
        for var i = 0; i < 10_000; i++ {
            Assert.True(ch.TryReceive(out var v, out var ok))
            Assert.True(ok)
            Assert.Equal(i, v)
        }
    }

    @Fact
    func Constructor_RejectsNegativeCapacity() {
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return Chan[int32](-1)
            }
        )
    }

    @Fact
    func Close_Twice_Throws_ButDisposeIsIdempotent() {
        let ch = Chan[int32](1)
        ch.Close()
        Assert.True(ch.IsClosed)
        Assert.Throws[ChannelClosedException](() -> ch.Close())
        Assert.False(ch.TryClose())
    }

    @Fact
    func Dispose_AfterClose_DoesNotThrow() {
        let ch = Chan[int32](1)
        ch.Close()
        ch.Dispose()
        ch.Dispose()
        Assert.True(ch.IsClosed)
    }

    @Fact
    func Dispose_ClosesAnOpenChannel() {
        let ch = Chan[int32](1)
        ch.TrySend(5)
        ch.Dispose()
        Assert.True(ch.IsClosed)
        Assert.Throws[ChannelClosedException](
            func () object? {
                return ch.TrySend(6)
            }
        )
        // Drains, then reports closed.
        Assert.True(ch.TryReceive(out var v, out var ok) && ok && v == 5)
        Assert.True(ch.TryReceive(out _, out ok))
        Assert.False(ok)
    }

    @Fact
    async func Send_OnClosedChannel_Throws() {
        let ch = Chan[int32](1)
        ch.Close()
        Assert.Throws[ChannelClosedException](
            func () object? {
                return ch.TrySend(1)
            }
        )
        let pending = ch.SendAsync(1)
        Assert.True(pending.IsFaulted)
        await Assert.ThrowsAsync[ChannelClosedException](
            async () -> {
                await pending
            }
        )
    }

    @Fact
    async func ReceiveAsync_ParkedThenSend_Completes() {
        let ch = Chan[int32](1)
        let receive = ch.ReceiveAsync().AsTask()
        Assert.False(receive.IsCompleted)
        Assert.Equal(1, ch.RegisteredWaiterCount)
        Assert.True(ch.TrySend(42))
        let result = await receive.WaitAsync(ChanTests.Timeout)
        Assert.True(result.Ok)
        Assert.Equal(42, result.Value)
        Assert.Equal(0, ch.RegisteredWaiterCount)
    }

    @Fact
    async func SendAsync_ParkedOnFullBuffer_CompletesWhenSlotFrees() {
        let ch = Chan[int32](1)
        Assert.True(ch.TrySend(1))
        let send = ch.SendAsync(2).AsTask()
        Assert.False(send.IsCompleted)
        Assert.True(ch.TryReceive(out var first, out _))
        Assert.Equal(1, first)
        await send.WaitAsync(ChanTests.Timeout)
        Assert.True(ch.TryReceive(out var second, out _))
        Assert.Equal(2, second)
    }

    @Fact
    async func ParkedReceivers_WakeInFifoOrder() {
        let ch = Chan[int32]()
        let order = List[int32]()
        let receives = List[Task[ReceiveResult[int32]]]()
        for var i = 0; i < 5; i++ {
            receives.Add(ch.ReceiveAsync().AsTask())
        }
        for var i = 0; i < 5; i++ {
            await ch.SendAsync(i).AsTask().WaitAsync(ChanTests.Timeout)
        }
        for var i = 0; i < 5; i++ {
            order.Add((await receives[i].WaitAsync(ChanTests.Timeout)).Value)
        }
        Assert.Equal([]int32{0, 1, 2, 3, 4}, order)
    }

    @Fact
    async func ParkedSenders_WakeInFifoOrder() {
        let ch = Chan[int32]()
        let sends = List[Task]()
        for var i = 0; i < 5; i++ {
            sends.Add(ch.SendAsync(i).AsTask())
        }
        let received = List[int32]()
        for var i = 0; i < 5; i++ {
            received.Add((await ch.ReceiveAsync().AsTask().WaitAsync(ChanTests.Timeout)).Value)
        }
        await Task.WhenAll(sends).WaitAsync(ChanTests.Timeout)
        Assert.Equal([]int32{0, 1, 2, 3, 4}, received)
    }

    @Fact
    async func Close_WithParkedReceivers_DeliversClosed_AndFaultsParkedSenders() {
        let ch = Chan[int32]()
        let receive = ch.ReceiveAsync().AsTask()
        let full = Chan[int32](1)
        full.TrySend(1)
        let send = full.SendAsync(2).AsTask()
        ch.Close()
        let result = await receive.WaitAsync(ChanTests.Timeout)
        Assert.False(result.Ok)
        Assert.Equal(0, result.Value)
        full.Close()
        await Assert.ThrowsAsync[ChannelClosedException](
            func () Task {
                return send.WaitAsync(ChanTests.Timeout)
            }
        )
    }

    @Fact
    async func ReceiveAsync_CancelledWhilePending_Throws_AndUnparks() {
        let ch = Chan[int32]()
        using let cts = CancellationTokenSource()
        let receive = ch.ReceiveAsync(cts.Token).AsTask()
        Assert.Equal(1, ch.RegisteredWaiterCount)
        cts.Cancel()
        await Assert.ThrowsAsync[OperationCanceledException](
            func () Task {
                return receive.WaitAsync(ChanTests.Timeout)
            }
        )
        Assert.Equal(0, ch.RegisteredWaiterCount)
    }

    @Fact
    async func ReceiveAsync_AlreadyCancelledToken_ThrowsWithoutParking() {
        let ch = Chan[int32]()
        let receive = ch.ReceiveAsync(CancellationToken(canceled: true))
        Assert.True(receive.IsCanceled)
        await Assert.ThrowsAsync[TaskCanceledException](
            func () Task {
                return receive.AsTask()
            }
        )
        Assert.Equal(0, ch.RegisteredWaiterCount)
    }

    @Fact
    async func ReceiveAsync_CancelRacingSend_NeverLosesValue() {
        // ADR-0174 D7 linearization rule: cancellation wins only before the
        // transfer commits. Every iteration either delivers the value to the
        // receiver or leaves it in the channel — never neither, never both.
        const Iterations = 10_000
        var delivered = 0
        var cancelled = 0
        for var i = 0; i < Iterations; i++ {
            let ch = Chan[int32](1)
            using let cts = CancellationTokenSource()
            let receive = ch.ReceiveAsync(cts.Token)
            Assert.False(receive.IsCompleted)
            let pending = receive.AsTask()
            using let barrier = Barrier(2)
            let sender = Task.Run(
                () -> {
                    barrier.SignalAndWait()
                    ch.TrySend(i)
                }
            )
            let canceller = Task.Run(
                () -> {
                    barrier.SignalAndWait()
                    cts.Cancel()
                }
            )
            await Task.WhenAll(sender, canceller).WaitAsync(ChanTests.Timeout)
            try {
                let result = await pending.WaitAsync(ChanTests.Timeout)
                Assert.True(result.Ok)
                Assert.Equal(i, result.Value)
                Assert.Equal(0, ch.Length())
                delivered++
            } catch (OperationCanceledException) {
                Assert.True(ch.TryReceive(out var v, out var ok))
                Assert.True(ok)
                Assert.Equal(i, v)
                cancelled++
            }
        }
        Assert.Equal(Iterations, delivered + cancelled)
        // Vacuity guard (ADR-0154): the race must actually have gone both ways.
        Assert.True(delivered > 0, "cancellation always won; the race was not exercised")
        Assert.True(cancelled > 0, "the send always won; the race was not exercised")
    }

    @Fact
    async func ClosedReceive_RaisesNoFirstChanceException() {
        let ch = Chan[int32](1)
        ch.Close()
        var closedExceptions = 0
        let handler EventHandler[FirstChanceExceptionEventArgs] = (_ object?, e FirstChanceExceptionEventArgs) -> {
            if e.Exception is ChannelClosedException {
                Interlocked.Increment(&closedExceptions)
            }
        }
        AppDomain.CurrentDomain.FirstChanceException += handler
        try {
            for var i = 0; i < 1_000; i++ {
                Assert.True(ch.TryReceive(out _, out var ok))
                Assert.False(ok)
                let result = await ch.ReceiveAsync()
                Assert.False(result.Ok)
            }
        } finally {
            AppDomain.CurrentDomain.FirstChanceException -= handler
        }
        Assert.Equal(0, closedExceptions)
    }

    @Fact
    async func HappensBefore_FieldWrittenBeforeSend_IsVisibleAfterReceive() {
        const Iterations = 200_000
        let ch = Chan[Payload](4)
        let producer = Task.Run(
            async () -> {
                for var i = 0; i < Iterations; i++ {
                    let p = Payload()
                    p.Plain = i + 1
                    p.Second = -(i + 1)
                    await ch.SendAsync(p)
                }
                ch.Close()
            }
        )
        var mismatches = 0
        var seen = 0
        while true {
            let result = await ch.ReceiveAsync()
            if !result.Ok {
                break
            }
            seen++
            if result.Value.Plain != seen || result.Value.Second != -seen {
                mismatches++
            }
        }
        await producer.WaitAsync(ChanTests.Timeout)
        Assert.Equal(Iterations, seen)
        Assert.Equal(0, mismatches)
    }

    @Fact
    async func PooledNodes_AreReusedAcrossParks_WithoutCrossTalk() {
        let ch = Chan[int32]()
        for var i = 0; i < 1_000; i++ {
            let receive = ch.ReceiveAsync().AsTask()
            await ch.SendAsync(i).AsTask().WaitAsync(ChanTests.Timeout)
            Assert.Equal(i, (await receive.WaitAsync(ChanTests.Timeout)).Value)
        }
    }

    private class Payload {
        var Plain int32
        var Second int32
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
