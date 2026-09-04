// <copyright file="ChanBatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D10 batch transfer: the completion table row by row, and D7's
/// partial-count rule under cancellation.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154, mutant applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/Chan{T}.Batch.cs</c>): removing the
/// <c>when (taken &gt; 0)</c> filter so a mid-batch cancellation throws breaks
/// <see cref="ReceiveBatchAsync_CancelledMidBatch_ReturnsCount_NeverBareThrow"/>
/// — the caller can no longer tell how much moved, and a retry duplicates.
/// </remarks>
public class ChanBatchTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void TryReceiveBatch_DrainsBufferedItems_AndReportsCount()
    {
        var ch = new Chan<int>(8);
        Assert.Equal(5, ch.TrySendBatch(new[] { 1, 2, 3, 4, 5 }));
        var buffer = new int[3];
        Assert.Equal(3, ch.TryReceiveBatch(buffer));
        Assert.Equal(new[] { 1, 2, 3 }, buffer);
        Assert.Equal(2, ch.TryReceiveBatch(buffer));
        Assert.Equal(new[] { 4, 5 }, buffer.Take(2));
        Assert.Equal(0, ch.TryReceiveBatch(buffer));
        Assert.False(ch.IsClosed);
        Assert.Equal(0, ch.TryReceiveBatch(Span<int>.Empty));
    }

    [Fact]
    public async Task TrySendBatch_FillsToCapacity_AndHandsToParkedReceivers()
    {
        var ch = new Chan<int>(2);
        var parked = ch.ReceiveAsync().AsTask();
        Assert.Equal(3, ch.TrySendBatch(new[] { 10, 20, 30, 40 }));
        Assert.Equal(10, (await parked.WaitAsync(Timeout)).Value);
        Assert.Equal(2, ch.Length());
        Assert.Equal(0, ch.TrySendBatch(new[] { 50 }));
    }

    [Fact]
    public void TrySendBatch_OnClosed_Throws()
    {
        var ch = new Chan<int>(2);
        ch.Close();
        Assert.Throws<ChannelClosedException>(() => ch.TrySendBatch(new[] { 1 }));
    }

    [Fact]
    public async Task ReceiveBatchAsync_AtLeastSatisfied_ReturnsWithoutParking()
    {
        var ch = new Chan<int>(8);
        ch.TrySendBatch(new[] { 1, 2, 3 });
        var buffer = new int[8];
        var pending = ch.ReceiveBatchAsync(buffer, atLeast: 2);
        Assert.True(pending.IsCompletedSuccessfully);
        Assert.Equal(3, await pending);
        Assert.Equal(new[] { 1, 2, 3 }, buffer.Take(3));
    }

    [Fact]
    public async Task ReceiveBatchAsync_FewerAvailable_ParksUntilAtLeast()
    {
        var ch = new Chan<int>(8);
        ch.TrySend(1);
        var buffer = new int[4];
        var pending = ch.ReceiveBatchAsync(buffer, atLeast: 3).AsTask();
        Assert.False(pending.IsCompleted);
        ch.TrySend(2);
        await Task.Delay(20);
        Assert.False(pending.IsCompleted);
        ch.TrySendBatch(new[] { 3, 4, 5 });
        var taken = await pending.WaitAsync(Timeout);
        Assert.True(taken >= 3 && taken <= 4);
        Assert.Equal(Enumerable.Range(1, taken), buffer.Take(taken));
    }

    [Fact]
    public async Task ReceiveBatchAsync_FullFillBarrier_WaitsForWholeBuffer()
    {
        var ch = new Chan<int>(2);
        var buffer = new int[6];
        var pending = ch.ReceiveBatchAsync(buffer, atLeast: buffer.Length).AsTask();
        var producer = Task.Run(async () =>
        {
            for (var i = 0; i < 6; i++)
            {
                await ch.SendAsync(i);
            }
        });
        Assert.Equal(6, await pending.WaitAsync(Timeout));
        Assert.Equal(Enumerable.Range(0, 6), buffer);
        await producer.WaitAsync(Timeout);
    }

    [Fact]
    public async Task ReceiveBatchAsync_ClosedMidBatch_ReturnsCountThenClosed()
    {
        var ch = new Chan<int>(8);
        ch.TrySend(1);
        var buffer = new int[4];
        var pending = ch.ReceiveBatchAsync(buffer, atLeast: 4).AsTask();
        Assert.False(pending.IsCompleted);
        ch.Close();
        Assert.Equal(1, await pending.WaitAsync(Timeout));

        // The next call reports closed: 0 and IsClosed.
        Assert.Equal(0, await ch.ReceiveBatchAsync(buffer, atLeast: 1));
        Assert.True(ch.IsClosed);
    }

    [Fact]
    public async Task ReceiveBatchAsync_CancelledMidBatch_ReturnsCount_NeverBareThrow()
    {
        var ch = new Chan<int>(8);
        ch.TrySendBatch(new[] { 1, 2 });
        using var cts = new CancellationTokenSource();
        var buffer = new int[5];
        var pending = ch.ReceiveBatchAsync(buffer, atLeast: 5, cts.Token).AsTask();
        Assert.False(pending.IsCompleted);
        cts.Cancel();
        Assert.Equal(2, await pending.WaitAsync(Timeout));
        Assert.Equal(new[] { 1, 2 }, buffer.Take(2));
        Assert.Equal(0, ch.Length());
    }

    [Fact]
    public async Task ReceiveBatchAsync_CancelledBeforeAnyTransfer_Throws()
    {
        var ch = new Chan<int>(8);
        using var cts = new CancellationTokenSource();
        var pending = ch.ReceiveBatchAsync(new int[3], atLeast: 1, cts.Token).AsTask();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending.WaitAsync(Timeout));
    }

    [Fact]
    public async Task SendBatchAsync_ParksOnFullBuffer_CompletesAsConsumed()
    {
        var ch = new Chan<int>(2);
        var pending = ch.SendBatchAsync(new[] { 1, 2, 3, 4, 5 }).AsTask();
        Assert.False(pending.IsCompleted);
        var received = new int[5];
        var got = 0;
        while (got < 5)
        {
            var r = await ch.ReceiveAsync().AsTask().WaitAsync(Timeout);
            received[got++] = r.Value;
        }

        Assert.Equal(5, await pending.WaitAsync(Timeout));
        Assert.Equal(new[] { 1, 2, 3, 4, 5 }, received);
    }

    [Fact]
    public async Task SendBatchAsync_CancelledMidBatch_ReturnsCountSoFar()
    {
        var ch = new Chan<int>(2);
        using var cts = new CancellationTokenSource();
        var pending = ch.SendBatchAsync(new[] { 1, 2, 3, 4 }, cts.Token).AsTask();
        Assert.False(pending.IsCompleted);
        cts.Cancel();
        Assert.Equal(2, await pending.WaitAsync(Timeout));
        Assert.Equal(2, ch.Length());
    }

    [Fact]
    public async Task SendBatchAsync_ClosedMidBatch_Throws()
    {
        var ch = new Chan<int>(1);
        var pending = ch.SendBatchAsync(new[] { 1, 2, 3 }).AsTask();
        ch.Close();
        await Assert.ThrowsAsync<ChannelClosedException>(() => pending.WaitAsync(Timeout));
    }

    [Fact]
    public async Task Rendezvous_Batch_DegeneratesToSequentialTransfers()
    {
        var ch = new Chan<int>();
        var buffer = new int[3];
        var pending = ch.ReceiveBatchAsync(buffer, atLeast: 3).AsTask();
        for (var i = 1; i <= 3; i++)
        {
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
        }

        Assert.Equal(3, await pending.WaitAsync(Timeout));
        Assert.Equal(new[] { 1, 2, 3 }, buffer);

        // Parked senders on a rendezvous channel are taken one hand-off at a time.
        var sends = Enumerable.Range(10, 3).Select(v => ch.SendAsync(v).AsTask()).ToArray();
        await Task.Delay(20);
        Assert.Equal(3, ch.TryReceiveBatch(buffer));
        Assert.Equal(new[] { 10, 11, 12 }, buffer);
        await Task.WhenAll(sends).WaitAsync(Timeout);
    }
}
