// <copyright file="ChannelBatchExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D10 on a directional handle: an `in chan[T]` is a
/// (cref:ChannelReader{T}) and an `out chan[T]` a
/// (cref:ChannelWriter{T}), so this is where the ADR's
/// `func (ch in chan[T]) …` receiver spelling binds. Each operation takes
/// the one-lock fast path on a (cref:Chan{T}) handle and degrades to
/// the element-wise loop on a foreign channel.
/// @remarks Discrimination witness (ADR-0154): a mutant that always takes the
/// element-wise fallback still passes every functional test here — the point of
/// the fast path is cost, not behaviour — so
/// (cref:TheFastPath_IsTakenForAGsharpChannel) asserts the unwrap
/// directly. A mutant that drops the mid-batch cancellation carve-out breaks
/// (cref:ReceiveBatch_CancelledMidBatch_ReturnsTheCountSoFar), which
/// then sees a bare throw and cannot tell how many elements it lost.
open class ChannelBatchExtensionsTests {
    @Fact
    func TheFastPath_IsTakenForAGsharpChannel() {
        let chan_ = Chan[int32](4)
        Assert.Same(chan_, Chan[int32].TryGetOwner(chan_.Reader))
        Assert.Same(chan_, Chan[int32].TryGetOwner(chan_.Writer))
        let foreign = Channel.CreateBounded[int32](4)
        Assert.Null(Chan[int32].TryGetOwner(foreign.Reader))
        Assert.Null(Chan[int32].TryGetOwner(foreign.Writer))
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func TryReceiveBatch_TakesEverythingBuffered(gsharp bool) {
        let (reader, writer) = Make(gsharp, 8)
        for var i = 0; i < 5; i++ {
            Assert.True(writer.TryWrite(i))
        }
        let buffer = [8]int32
        Assert.Equal(5, reader.TryReceiveBatch(buffer.AsSpan()))
        Assert.Equal([]int32{0, 1, 2, 3, 4}, buffer[.. 5])
        Assert.Equal(0, reader.TryReceiveBatch(buffer.AsSpan()))
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func TrySendBatch_FillsTheRoomThereIs(gsharp bool) {
        let (reader, writer) = Make(gsharp, 3)
        Assert.Equal(3, writer.TrySendBatch([]int32{1, 2, 3, 4, 5}.AsSpan()))
        let buffer = [8]int32
        Assert.Equal(3, reader.TryReceiveBatch(buffer.AsSpan()))
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    async func ReceiveBatch_AtLeastOne_TakesWhatIsThere(gsharp bool) {
        let (reader, writer) = Make(gsharp, 8)
        writer.TryWrite(1)
        writer.TryWrite(2)
        let buffer = [8]int32
        let taken = await reader
            .ReceiveBatch(buffer, atLeast: 1)
            .AsTask()
            .WaitAsync(ChannelBatchExtensionsTests.Timeout)
        Assert.Equal(2, taken)
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    async func ReceiveBatch_FullFill_ParksUntilEnoughArrive(gsharp bool) {
        let (reader, writer) = Make(gsharp, 8)
        let buffer = [4]int32
        let pending = reader.ReceiveBatch(buffer, atLeast: 4).AsTask()
        Assert.False(pending.IsCompleted)
        for var i = 0; i < 4; i++ {
            Assert.True(writer.TryWrite(i))
        }
        Assert.Equal(4, await pending.WaitAsync(ChannelBatchExtensionsTests.Timeout))
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    async func ReceiveBatch_ClosedMidBatch_ReturnsTheCountSoFar(gsharp bool) {
        let (reader, writer) = Make(gsharp, 8)
        writer.TryWrite(1)
        writer.TryWrite(2)
        writer.TryComplete()
        let buffer = [8]int32
        Assert.Equal(
            2,
            await reader.ReceiveBatch(buffer, atLeast: 4).AsTask().WaitAsync(ChannelBatchExtensionsTests.Timeout)
        )
        // The next call reports closed, not the count.
        Assert.Equal(
            0,
            await reader.ReceiveBatch(buffer, atLeast: 1).AsTask().WaitAsync(ChannelBatchExtensionsTests.Timeout)
        )
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    async func ReceiveBatch_CancelledMidBatch_ReturnsTheCountSoFar(gsharp bool) {
        // D7's linearization rule: never a bare throw that hides the count and
        // invites duplicates on retry.
        let (reader, writer) = Make(gsharp, 8)
        writer.TryWrite(1)
        using let cts = CancellationTokenSource()
        let context = Context.FromToken(cts.Token)
        let buffer = [8]int32
        let pending = reader.ReceiveBatch(buffer, atLeast: 4, context).AsTask()
        cts.Cancel()
        Assert.Equal(1, await pending.WaitAsync(ChannelBatchExtensionsTests.Timeout))
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    async func ReceiveBatch_CancelledBeforeAnyElement_Throws(gsharp bool) {
        let (reader, _) = Make(gsharp, 8)
        using let cts = CancellationTokenSource()
        let buffer = [8]int32
        let pending = reader.ReceiveBatch(buffer, atLeast: 1, Context.FromToken(cts.Token)).AsTask()
        cts.Cancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return pending.WaitAsync(ChannelBatchExtensionsTests.Timeout)
            }
        )
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    async func SendBatch_DeliversEveryElement(gsharp bool) {
        let (reader, writer) = Make(gsharp, 2)
        let sending = writer.SendBatch([]int32{1, 2, 3, 4, 5}).AsTask()
        var seen = 0
        let buffer = [8]int32
        while seen < 5 {
            seen += await reader
                .ReceiveBatch(buffer, atLeast: 1)
                .AsTask()
                .WaitAsync(ChannelBatchExtensionsTests.Timeout)
        }
        Assert.Equal(5, await sending.WaitAsync(ChannelBatchExtensionsTests.Timeout))
        Assert.Equal(5, seen)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)

        private func Make(gsharp bool, capacity int32)(Reader ChannelReader[int32], Writer ChannelWriter[int32]) {
            if gsharp {
                let chan_ = Chan[int32](capacity)
                return (chan_.Reader, chan_.Writer)
            }
            let foreign = Channel.CreateBounded[int32](capacity)
            return (foreign.Reader, foreign.Writer)
        }
    }
}
