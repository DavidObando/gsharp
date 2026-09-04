// <copyright file="ChunkReaderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D10's language-facing shape: <c>for batch in chunks(ch, n)</c>.
/// The reader hands over whole buffers, so one lock acquisition and one park
/// are amortized across a batch, and it is an ordinary
/// <see cref="ChannelReader{T}"/> so the loop needs no new syntax.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that waits to fill the whole
/// chunk (<c>atLeast: size</c> instead of 1) breaks
/// <see cref="APartialChunk_IsHandedOverWithoutWaitingToFill"/>, which then
/// never returns — a pipeline whose producer is slower than its chunk size
/// would stall. A mutant that hands back a reused buffer breaks
/// <see cref="EachChunkOwnsItsBuffer"/>, where the first batch's contents
/// change under the reader once the second arrives.
/// </remarks>
public class ChunkReaderTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task EveryElementArrivesExactlyOnce()
    {
        var chan = new Chan<int>(64);
        var reader = Chunks.Of(chan, 64);
        var producer = Task.Run(async () =>
        {
            for (var i = 1; i <= 1000; i++)
            {
                await chan.SendAsync(i);
            }

            chan.Close();
        });

        var total = 0L;
        var count = 0;
        await foreach (var batch in reader.ReadAllAsync().ConfigureAwait(false))
        {
            count += batch.Length;
            foreach (var value in batch.Span)
            {
                total += value;
            }
        }

        await producer.WaitAsync(Timeout);
        Assert.Equal(1000, count);
        Assert.Equal(500500L, total);
    }

    [Fact]
    public async Task APartialChunk_IsHandedOverWithoutWaitingToFill()
    {
        // atLeast = 1 is the Go `range` shape: take what is there. Waiting to
        // fill would stall a pipeline whose producer is slower than the chunk.
        var chan = new Chan<int>(64);
        var reader = Chunks.Of(chan, 1024);
        Assert.True(chan.Writer.TryWrite(7));

        var batch = await reader.ReadAsync().AsTask().WaitAsync(Timeout);
        Assert.Equal(1, batch.Length);
        Assert.Equal(7, batch.Span[0]);
    }

    [Fact]
    public async Task EachChunkOwnsItsBuffer()
    {
        var chan = new Chan<int>(64);
        var reader = Chunks.Of(chan, 2);
        chan.Writer.TryWrite(1);
        chan.Writer.TryWrite(2);
        var first = await reader.ReadAsync().AsTask().WaitAsync(Timeout);

        chan.Writer.TryWrite(3);
        chan.Writer.TryWrite(4);
        var second = await reader.ReadAsync().AsTask().WaitAsync(Timeout);

        Assert.Equal(new[] { 1, 2 }, first.ToArray());
        Assert.Equal(new[] { 3, 4 }, second.ToArray());
    }

    [Fact]
    public async Task AClosedChannel_EndsTheLoop()
    {
        var chan = new Chan<int>(4);
        var reader = Chunks.Of(chan, 4);
        chan.Writer.TryWrite(1);
        chan.Close();

        var batch = await reader.ReadAsync().AsTask().WaitAsync(Timeout);
        Assert.Equal(1, batch.Length);
        Assert.False(await reader.WaitToReadAsync().AsTask().WaitAsync(Timeout));
    }

    [Fact]
    public void TryRead_ReportsNothingWhenTheChannelIsEmpty()
    {
        var chan = new Chan<int>(4);
        var reader = Chunks.Of(chan, 4);
        Assert.False(reader.TryRead(out _));

        chan.Writer.TryWrite(1);
        Assert.True(reader.TryRead(out var batch));
        Assert.Equal(1, batch.Length);
    }

    [Fact]
    public void AChunkHoldsAtLeastOneElement()
        => Assert.Throws<ArgumentOutOfRangeException>(() => Chunks.Of(new Chan<int>(1), 0));

    [Fact]
    public async Task AForeignChannel_ChunksThroughTheFallback()
    {
        var foreign = Channel.CreateBounded<int>(8);
        var reader = Chunks.Of(foreign, 4);
        for (var i = 1; i <= 6; i++)
        {
            Assert.True(foreign.Writer.TryWrite(i));
        }

        foreign.Writer.TryComplete();

        var count = 0;
        await foreach (var batch in reader.ReadAllAsync().ConfigureAwait(false))
        {
            count += batch.Length;
        }

        Assert.Equal(6, count);
    }
}
