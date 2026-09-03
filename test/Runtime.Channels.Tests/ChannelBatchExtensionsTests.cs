// <copyright file="ChannelBatchExtensionsTests.cs" company="GSharp">
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
/// ADR-0174 D10 on a directional handle: an <c>in chan[T]</c> is a
/// <see cref="ChannelReader{T}"/> and an <c>out chan[T]</c> a
/// <see cref="ChannelWriter{T}"/>, so this is where the ADR's
/// <c>func (ch in chan[T]) …</c> receiver spelling binds. Each operation takes
/// the one-lock fast path on a <see cref="Chan{T}"/> handle and degrades to
/// the element-wise loop on a foreign channel.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that always takes the
/// element-wise fallback still passes every functional test here — the point of
/// the fast path is cost, not behaviour — so
/// <see cref="TheFastPath_IsTakenForAGsharpChannel"/> asserts the unwrap
/// directly. A mutant that drops the mid-batch cancellation carve-out breaks
/// <see cref="ReceiveBatch_CancelledMidBatch_ReturnsTheCountSoFar"/>, which
/// then sees a bare throw and cannot tell how many elements it lost.
/// </remarks>
public class ChannelBatchExtensionsTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void TheFastPath_IsTakenForAGsharpChannel()
    {
        var chan = new Chan<int>(4);
        Assert.Same(chan, Chan<int>.TryGetOwner(chan.Reader));
        Assert.Same(chan, Chan<int>.TryGetOwner(chan.Writer));

        var foreign = Channel.CreateBounded<int>(4);
        Assert.Null(Chan<int>.TryGetOwner(foreign.Reader));
        Assert.Null(Chan<int>.TryGetOwner(foreign.Writer));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TryReceiveBatch_TakesEverythingBuffered(bool gsharp)
    {
        var (reader, writer) = Make(gsharp, 8);
        for (var i = 0; i < 5; i++)
        {
            Assert.True(writer.TryWrite(i));
        }

        var buffer = new int[8];
        Assert.Equal(5, reader.TryReceiveBatch(buffer.AsSpan()));
        Assert.Equal(new[] { 0, 1, 2, 3, 4 }, buffer[..5]);
        Assert.Equal(0, reader.TryReceiveBatch(buffer.AsSpan()));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TrySendBatch_FillsTheRoomThereIs(bool gsharp)
    {
        var (reader, writer) = Make(gsharp, 3);
        Assert.Equal(3, writer.TrySendBatch(new[] { 1, 2, 3, 4, 5 }.AsSpan()));

        var buffer = new int[8];
        Assert.Equal(3, reader.TryReceiveBatch(buffer.AsSpan()));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReceiveBatch_AtLeastOne_TakesWhatIsThere(bool gsharp)
    {
        var (reader, writer) = Make(gsharp, 8);
        writer.TryWrite(1);
        writer.TryWrite(2);

        var buffer = new int[8];
        var taken = await reader.ReceiveBatch(buffer, atLeast: 1).AsTask().WaitAsync(Timeout);
        Assert.Equal(2, taken);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReceiveBatch_FullFill_ParksUntilEnoughArrive(bool gsharp)
    {
        var (reader, writer) = Make(gsharp, 8);
        var buffer = new int[4];
        var pending = reader.ReceiveBatch(buffer, atLeast: 4).AsTask();
        Assert.False(pending.IsCompleted);

        for (var i = 0; i < 4; i++)
        {
            Assert.True(writer.TryWrite(i));
        }

        Assert.Equal(4, await pending.WaitAsync(Timeout));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReceiveBatch_ClosedMidBatch_ReturnsTheCountSoFar(bool gsharp)
    {
        var (reader, writer) = Make(gsharp, 8);
        writer.TryWrite(1);
        writer.TryWrite(2);
        writer.TryComplete();

        var buffer = new int[8];
        Assert.Equal(2, await reader.ReceiveBatch(buffer, atLeast: 4).AsTask().WaitAsync(Timeout));

        // The next call reports closed, not the count.
        Assert.Equal(0, await reader.ReceiveBatch(buffer, atLeast: 1).AsTask().WaitAsync(Timeout));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReceiveBatch_CancelledMidBatch_ReturnsTheCountSoFar(bool gsharp)
    {
        // D7's linearization rule: never a bare throw that hides the count and
        // invites duplicates on retry.
        var (reader, writer) = Make(gsharp, 8);
        writer.TryWrite(1);
        using var cts = new CancellationTokenSource();
        var context = Context.FromToken(cts.Token);

        var buffer = new int[8];
        var pending = reader.ReceiveBatch(buffer, atLeast: 4, context).AsTask();
        cts.Cancel();
        Assert.Equal(1, await pending.WaitAsync(Timeout));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReceiveBatch_CancelledBeforeAnyElement_Throws(bool gsharp)
    {
        var (reader, _) = Make(gsharp, 8);
        using var cts = new CancellationTokenSource();
        var buffer = new int[8];
        var pending = reader.ReceiveBatch(buffer, atLeast: 1, Context.FromToken(cts.Token)).AsTask();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending.WaitAsync(Timeout));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task SendBatch_DeliversEveryElement(bool gsharp)
    {
        var (reader, writer) = Make(gsharp, 2);
        var sending = writer.SendBatch(new[] { 1, 2, 3, 4, 5 }).AsTask();

        var seen = 0;
        var buffer = new int[8];
        while (seen < 5)
        {
            seen += await reader.ReceiveBatch(buffer, atLeast: 1).AsTask().WaitAsync(Timeout);
        }

        Assert.Equal(5, await sending.WaitAsync(Timeout));
        Assert.Equal(5, seen);
    }

    private static (ChannelReader<int> Reader, ChannelWriter<int> Writer) Make(bool gsharp, int capacity)
    {
        if (gsharp)
        {
            var chan = new Chan<int>(capacity);
            return (chan.Reader, chan.Writer);
        }

        var foreign = Channel.CreateBounded<int>(capacity);
        return (foreign.Reader, foreign.Writer);
    }
}
