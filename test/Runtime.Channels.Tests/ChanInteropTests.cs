// <copyright file="ChanInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D1/D2: a <see cref="Chan{T}"/> <em>is</em> a <see cref="Channel{T}"/>
/// — assignable, consumable by <c>ReadAllAsync</c>, honoring the BCL
/// reader/writer contracts — while refusing to fault.
/// </summary>
public class ChanInteropTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void Chan_IsAssignableTo_ChannelReaderAndWriter()
    {
        var ch = new Chan<int>(1);
        Channel<int> asChannel = ch;
        ChannelReader<int> reader = ch.Reader;
        ChannelWriter<int> writer = ch.Writer;
        Assert.Same(ch, asChannel);
        Assert.True(writer.TryWrite(1));
        Assert.True(reader.TryRead(out var v));
        Assert.Equal(1, v);
        Assert.True(reader.CanCount);
        Assert.Equal(0, reader.Count);
        Assert.False(reader.CanPeek);
    }

    [Fact]
    public async Task ReadAllAsync_ConsumesUntilClosed()
    {
        var ch = new Chan<int>(2);
        var producer = Task.Run(async () =>
        {
            for (var i = 0; i < 10; i++)
            {
                await ch.Writer.WriteAsync(i);
            }

            ch.Writer.Complete();
        });

        var seen = new List<int>();
        await foreach (var item in ch.Reader.ReadAllAsync())
        {
            seen.Add(item);
        }

        await producer.WaitAsync(Timeout);
        Assert.Equal(10, seen.Count);
        Assert.Equal(45, seen.Sum());
        Assert.True(ch.Reader.Completion.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task ReadAsync_OnClosedAndDrained_ThrowsChannelClosed_PerBclContract()
    {
        var ch = new Chan<int>(1);
        ch.TrySend(1);
        ch.Close();
        Assert.Equal(1, await ch.Reader.ReadAsync());
        await Assert.ThrowsAsync<ChannelClosedException>(async () => await ch.Reader.ReadAsync());
    }

    [Fact]
    public void TryWrite_OnClosed_ReturnsFalse_NotThrow()
    {
        var ch = new Chan<int>(1);
        ch.Close();
        Assert.False(ch.Writer.TryWrite(1));
    }

    [Fact]
    public void TryComplete_WithError_IsRejected_ChanNeverFaults()
    {
        var ch = new Chan<int>(1);
        Assert.Throws<NotSupportedException>(() => ch.Writer.TryComplete(new InvalidOperationException("boom")));
        Assert.False(ch.IsClosed);
        Assert.True(ch.Writer.TryComplete());
        Assert.False(ch.Writer.TryComplete());
        Assert.True(ch.IsClosed);
    }

    [Fact]
    public async Task WaitToReadAsync_SignalsReadiness_AndFalseOnClose()
    {
        var ch = new Chan<int>(1);
        var wait = ch.Reader.WaitToReadAsync().AsTask();
        Assert.False(wait.IsCompleted);
        ch.TrySend(1);
        Assert.True(await wait.WaitAsync(Timeout));

        // Readiness, not reservation: the item is still there for TryRead.
        Assert.True(ch.Reader.TryRead(out var v));
        Assert.Equal(1, v);

        var waitAgain = ch.Reader.WaitToReadAsync().AsTask();
        ch.Close();
        Assert.False(await waitAgain.WaitAsync(Timeout));
        Assert.False(await ch.Reader.WaitToReadAsync());
    }

    [Fact]
    public async Task WaitToReadAsync_OnRendezvous_IsTrueWhenASenderIsParked()
    {
        var ch = new Chan<int>();
        var wait = ch.Reader.WaitToReadAsync().AsTask();
        Assert.False(wait.IsCompleted);
        var send = ch.SendAsync(3).AsTask();
        Assert.True(await wait.WaitAsync(Timeout));
        Assert.True(ch.Reader.TryRead(out var v));
        Assert.Equal(3, v);
        await send.WaitAsync(Timeout);
    }

    [Fact]
    public async Task WaitToWriteAsync_SignalsRoom_AndFalseOnClose()
    {
        var ch = new Chan<int>(1);
        Assert.True(await ch.Writer.WaitToWriteAsync());
        ch.TrySend(1);
        var wait = ch.Writer.WaitToWriteAsync().AsTask();
        Assert.False(wait.IsCompleted);
        ch.TryReceive(out _, out _);
        Assert.True(await wait.WaitAsync(Timeout));

        ch.Close();
        Assert.False(await ch.Writer.WaitToWriteAsync());
    }

    [Fact]
    public async Task WaitToReadAsync_Cancelled_Throws()
    {
        var ch = new Chan<int>(1);
        using var cts = new CancellationTokenSource();
        var wait = ch.Reader.WaitToReadAsync(cts.Token).AsTask();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => wait.WaitAsync(Timeout));
        Assert.Equal(0, ch.RegisteredWaiterCount);
    }

    [Fact]
    public void ReceiveResult_Deconstructs_ToGoShapedPair()
    {
        var (value, ok) = new ReceiveResult<string>("x", true);
        Assert.Equal("x", value);
        Assert.True(ok);
        var (zero, closed) = ReceiveResult<int>.Closed;
        Assert.Equal(0, zero);
        Assert.False(closed);
    }
}
