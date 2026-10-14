// <copyright file="ChanBatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Linq
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D10 batch transfer: the completion table row by row, and D7's
/// partial-count rule under cancellation.
/// @remarks Discrimination witness (ADR-0154, mutant applied to
/// `src/Sdk/Gsharp.Runtime.Channels/Chan{T}.Batch.cs`): removing the
/// `when (taken > 0)` filter so a mid-batch cancellation throws breaks
/// (cref:ReceiveBatchAsync_CancelledMidBatch_ReturnsCount_NeverBareThrow)
/// — the caller can no longer tell how much moved, and a retry duplicates.
open class ChanBatchTests {
    @Fact
    func TryReceiveBatch_DrainsBufferedItems_AndReportsCount() {
        let ch = Chan[int32](8)
        Assert.Equal(5, ch.TrySendBatch([]int32{1, 2, 3, 4, 5}))
        let buffer = [3]int32
        Assert.Equal(3, ch.TryReceiveBatch(buffer))
        Assert.Equal([]int32{1, 2, 3}, buffer)
        Assert.Equal(2, ch.TryReceiveBatch(buffer))
        Assert.Equal([]int32{4, 5}, buffer.Take(2))
        Assert.Equal(0, ch.TryReceiveBatch(buffer))
        Assert.False(ch.IsClosed)
        Assert.Equal(0, ch.TryReceiveBatch(Span[int32].Empty))
    }

    @Fact
    async func TrySendBatch_FillsToCapacity_AndHandsToParkedReceivers() {
        let ch = Chan[int32](2)
        let parked = ch.ReceiveAsync().AsTask()
        Assert.Equal(3, ch.TrySendBatch([]int32{10, 20, 30, 40}))
        Assert.Equal(10, (await parked.WaitAsync(ChanBatchTests.Timeout)).Value)
        Assert.Equal(2, ch.Length())
        Assert.Equal(0, ch.TrySendBatch([]int32{50}))
    }

    @Fact
    func TrySendBatch_OnClosed_Throws() {
        let ch = Chan[int32](2)
        ch.Close()
        Assert.Throws[ChannelClosedException](
            func () object? {
                return ch.TrySendBatch([]int32{1})
            }
        )
    }

    @Fact
    async func ReceiveBatchAsync_AtLeastSatisfied_ReturnsWithoutParking() {
        let ch = Chan[int32](8)
        ch.TrySendBatch([]int32{1, 2, 3})
        let buffer = [8]int32
        let pending = ch.ReceiveBatchAsync(buffer, atLeast: 2)
        Assert.True(pending.IsCompletedSuccessfully)
        Assert.Equal(3, await pending)
        Assert.Equal([]int32{1, 2, 3}, buffer.Take(3))
    }

    @Fact
    async func ReceiveBatchAsync_FewerAvailable_ParksUntilAtLeast() {
        let ch = Chan[int32](8)
        ch.TrySend(1)
        let buffer = [4]int32
        let pending = ch.ReceiveBatchAsync(buffer, atLeast: 3).AsTask()
        Assert.False(pending.IsCompleted)
        ch.TrySend(2)
        await Task.Delay(20)
        Assert.False(pending.IsCompleted)
        ch.TrySendBatch([]int32{3, 4, 5})
        let taken = await pending.WaitAsync(ChanBatchTests.Timeout)
        Assert.True(taken >= 3 && taken <= 4)
        Assert.Equal(Enumerable.Range(1, taken), buffer.Take(taken))
    }

    @Fact
    async func ReceiveBatchAsync_FullFillBarrier_WaitsForWholeBuffer() {
        let ch = Chan[int32](2)
        let buffer = [6]int32
        let pending = ch.ReceiveBatchAsync(buffer, atLeast: buffer.Length).AsTask()
        let producer = Task.Run(
            async () -> {
                for var i = 0; i < 6; i++ {
                    await ch.SendAsync(i)
                }
            }
        )
        Assert.Equal(6, await pending.WaitAsync(ChanBatchTests.Timeout))
        Assert.Equal(Enumerable.Range(0, 6), buffer)
        await producer.WaitAsync(ChanBatchTests.Timeout)
    }

    @Fact
    async func ReceiveBatchAsync_ClosedMidBatch_ReturnsCountThenClosed() {
        let ch = Chan[int32](8)
        ch.TrySend(1)
        let buffer = [4]int32
        let pending = ch.ReceiveBatchAsync(buffer, atLeast: 4).AsTask()
        Assert.False(pending.IsCompleted)
        ch.Close()
        Assert.Equal(1, await pending.WaitAsync(ChanBatchTests.Timeout))
        // The next call reports closed: 0 and IsClosed.
        Assert.Equal(0, await ch.ReceiveBatchAsync(buffer, atLeast: 1))
        Assert.True(ch.IsClosed)
    }

    @Fact
    async func ReceiveBatchAsync_CancelledMidBatch_ReturnsCount_NeverBareThrow() {
        let ch = Chan[int32](8)
        ch.TrySendBatch([]int32{1, 2})
        using let cts = CancellationTokenSource()
        let buffer = [5]int32
        let pending = ch.ReceiveBatchAsync(buffer, atLeast: 5, cts.Token).AsTask()
        Assert.False(pending.IsCompleted)
        cts.Cancel()
        Assert.Equal(2, await pending.WaitAsync(ChanBatchTests.Timeout))
        Assert.Equal([]int32{1, 2}, buffer.Take(2))
        Assert.Equal(0, ch.Length())
    }

    @Fact
    async func ReceiveBatchAsync_CancelledBeforeAnyTransfer_Throws() {
        let ch = Chan[int32](8)
        using let cts = CancellationTokenSource()
        let pending = ch.ReceiveBatchAsync([3]int32, atLeast: 1, cts.Token).AsTask()
        cts.Cancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return pending.WaitAsync(ChanBatchTests.Timeout)
            }
        )
    }

    @Fact
    async func SendBatchAsync_ParksOnFullBuffer_CompletesAsConsumed() {
        let ch = Chan[int32](2)
        let pending = ch.SendBatchAsync([]int32{1, 2, 3, 4, 5}).AsTask()
        Assert.False(pending.IsCompleted)
        let received = [5]int32
        var got = 0
        while got < 5 {
            let r = await ch.ReceiveAsync().AsTask().WaitAsync(ChanBatchTests.Timeout)
            received[got] = r.Value
            got++
        }
        Assert.Equal(5, await pending.WaitAsync(ChanBatchTests.Timeout))
        Assert.Equal([]int32{1, 2, 3, 4, 5}, received)
    }

    @Fact
    async func SendBatchAsync_CancelledMidBatch_ReturnsCountSoFar() {
        let ch = Chan[int32](2)
        using let cts = CancellationTokenSource()
        let pending = ch.SendBatchAsync([]int32{1, 2, 3, 4}, cts.Token).AsTask()
        Assert.False(pending.IsCompleted)
        cts.Cancel()
        Assert.Equal(2, await pending.WaitAsync(ChanBatchTests.Timeout))
        Assert.Equal(2, ch.Length())
    }

    @Fact
    async func SendBatchAsync_ClosedMidBatch_Throws() {
        let ch = Chan[int32](1)
        let pending = ch.SendBatchAsync([]int32{1, 2, 3}).AsTask()
        ch.Close()
        await Assert.ThrowsAsync[ChannelClosedException](
            func () Task {
                return pending.WaitAsync(ChanBatchTests.Timeout)
            }
        )
    }

    @Fact
    async func Rendezvous_Batch_DegeneratesToSequentialTransfers() {
        let ch = Chan[int32]()
        let buffer = [3]int32
        let pending = ch.ReceiveBatchAsync(buffer, atLeast: 3).AsTask()
        for var i = 1; i <= 3; i++ {
            await ch.SendAsync(i).AsTask().WaitAsync(ChanBatchTests.Timeout)
        }
        Assert.Equal(3, await pending.WaitAsync(ChanBatchTests.Timeout))
        Assert.Equal([]int32{1, 2, 3}, buffer)
        // Parked senders on a rendezvous channel are taken one hand-off at a time.
        let sends = Enumerable.Range(10, 3).Select((v int32) -> ch.SendAsync(v).AsTask()).ToArray()
        await Task.Delay(20)
        Assert.Equal(3, ch.TryReceiveBatch(buffer))
        Assert.Equal([]int32{10, 11, 12}, buffer)
        await Task.WhenAll(sends).WaitAsync(ChanBatchTests.Timeout)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
