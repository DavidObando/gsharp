// <copyright file="ChunkReaderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// ADR-0174 D10's language-facing shape: `for batch in chunks(ch, n)`.
/// The reader hands over whole buffers, so one lock acquisition and one park
/// are amortized across a batch, and it is an ordinary
/// (cref:ChannelReader{T}) so the loop needs no new syntax.
/// @remarks Discrimination witness (ADR-0154): a mutant that waits to fill the whole
/// chunk (`atLeast: size` instead of 1) breaks
/// (cref:APartialChunk_IsHandedOverWithoutWaitingToFill), which then
/// never returns — a pipeline whose producer is slower than its chunk size
/// would stall. A mutant that hands back a reused buffer breaks
/// (cref:EachChunkOwnsItsBuffer), where the first batch's contents
/// change under the reader once the second arrives.
open class ChunkReaderTests {
    @Fact
    async func EveryElementArrivesExactlyOnce() {
        let chan_ = Chan[int32](64)
        let reader = Chunks.Of(chan_, 64)
        let producer = Task.Run(
            async () -> {
                for var i = 1; i <= 1000; i++ {
                    await chan_.SendAsync(i)
                }
                chan_.Close()
            }
        )
        var total = 0L
        var count = 0
        await for batch in reader.ReadAllAsync().ConfigureAwait(false) {
            count += batch.Length
            for value in batch.Span {
                total += int64(value)
            }
        }
        await producer.WaitAsync(ChunkReaderTests.Timeout)
        Assert.Equal(1000, count)
        Assert.Equal(500500L, total)
    }

    @Fact
    async func APartialChunk_IsHandedOverWithoutWaitingToFill() {
        // atLeast = 1 is the Go `range` shape: take what is there. Waiting to
        // fill would stall a pipeline whose producer is slower than the chunk.
        let chan_ = Chan[int32](64)
        let reader = Chunks.Of(chan_, 1024)
        Assert.True(chan_.Writer.TryWrite(7))
        let batch = await reader.ReadAsync().AsTask().WaitAsync(ChunkReaderTests.Timeout)
        Assert.Equal(1, batch.Length)
        Assert.Equal(7, batch.Span[0])
    }

    @Fact
    async func EachChunkOwnsItsBuffer() {
        let chan_ = Chan[int32](64)
        let reader = Chunks.Of(chan_, 2)
        chan_.Writer.TryWrite(1)
        chan_.Writer.TryWrite(2)
        let first = await reader.ReadAsync().AsTask().WaitAsync(ChunkReaderTests.Timeout)
        chan_.Writer.TryWrite(3)
        chan_.Writer.TryWrite(4)
        let second = await reader.ReadAsync().AsTask().WaitAsync(ChunkReaderTests.Timeout)
        Assert.Equal([]int32{1, 2}, first.ToArray())
        Assert.Equal([]int32{3, 4}, second.ToArray())
    }

    @Fact
    async func AClosedChannel_EndsTheLoop() {
        let chan_ = Chan[int32](4)
        let reader = Chunks.Of(chan_, 4)
        chan_.Writer.TryWrite(1)
        chan_.Close()
        let batch = await reader.ReadAsync().AsTask().WaitAsync(ChunkReaderTests.Timeout)
        Assert.Equal(1, batch.Length)
        Assert.False(await reader.WaitToReadAsync().AsTask().WaitAsync(ChunkReaderTests.Timeout))
    }

    @Fact
    func TryRead_ReportsNothingWhenTheChannelIsEmpty() {
        let chan_ = Chan[int32](4)
        let reader = Chunks.Of(chan_, 4)
        Assert.False(reader.TryRead(out _))
        chan_.Writer.TryWrite(1)
        Assert.True(reader.TryRead(out var batch))
        Assert.Equal(1, batch.Length)
    }

    @Fact
    func AChunkHoldsAtLeastOneElement() -> Assert.Throws[ArgumentOutOfRangeException](
        func () object? {
            return Chunks.Of(Chan[int32](1), 0)
        }
    )

    @Fact
    async func AForeignChannel_ChunksThroughTheFallback() {
        let foreign = Channel.CreateBounded[int32](8)
        let reader = Chunks.Of(foreign, 4)
        for var i = 1; i <= 6; i++ {
            Assert.True(foreign.Writer.TryWrite(i))
        }
        foreign.Writer.TryComplete()
        var count = 0
        await for batch in reader.ReadAllAsync().ConfigureAwait(false) {
            count += batch.Length
        }
        Assert.Equal(6, count)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
