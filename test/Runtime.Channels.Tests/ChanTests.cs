// <copyright file="ChanTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D1/D3 semantics of <see cref="Chan{T}"/>: the three-state receive
/// encoding, FIFO buffering, close/dispose, cancellation linearization, and
/// the happens-before guarantee.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, product mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/Chan{T}.cs</c>): returning
/// <c>(true, false)</c> for an open empty channel breaks
/// <see cref="TryReceive_ThreeStates_AreEncodedNormatively"/>; routing
/// <c>Dispose</c> to <c>Close</c> breaks <see cref="Dispose_AfterClose_DoesNotThrow"/>;
/// returning the buffered count from <c>Capacity</c> (or the capacity from
/// <c>Length()</c>) breaks <see cref="Length_And_Capacity_Differ_WhenPartiallyFilled"/>;
/// restoring a <c>ChannelClosedException</c>-based closed-receive breaks
/// <see cref="ClosedReceive_RaisesNoFirstChanceException"/>; letting the
/// cancellation callback complete an already-committed node breaks
/// <see cref="ReceiveAsync_CancelRacingSend_NeverLosesValue"/>; publishing the
/// node's result before the value deposit breaks
/// <see cref="HappensBefore_FieldWrittenBeforeSend_IsVisibleAfterReceive"/>.
/// </remarks>
public class ChanTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void TryReceive_ThreeStates_AreEncodedNormatively()
    {
        var ch = new Chan<int>(2);

        // (false, _): nothing available right now, channel open.
        Assert.False(ch.TryReceive(out _, out _));

        // (true, true): a value.
        Assert.True(ch.TrySend(7));
        Assert.True(ch.TryReceive(out var value, out var ok));
        Assert.True(ok);
        Assert.Equal(7, value);

        // (true, false): closed and drained, value is the zero.
        ch.Close();
        Assert.True(ch.TryReceive(out value, out ok));
        Assert.False(ok);
        Assert.Equal(0, value);
    }

    [Fact]
    public void BufferedChannel_IsFifo_AndTrySendFailsWhenFull()
    {
        var ch = new Chan<int>(3);
        Assert.True(ch.TrySend(1));
        Assert.True(ch.TrySend(2));
        Assert.True(ch.TrySend(3));
        Assert.False(ch.TrySend(4));
        Assert.Equal(3, ch.Length());

        var drained = new List<int>();
        while (ch.TryReceive(out var v, out var ok) && ok)
        {
            drained.Add(v);
        }

        Assert.Equal(new[] { 1, 2, 3 }, drained);
        Assert.Equal(0, ch.Length());
    }

    [Fact]
    public void Length_And_Capacity_Differ_WhenPartiallyFilled()
    {
        var ch = new Chan<int>(8);
        ch.TrySend(1);
        ch.TrySend(2);
        ch.TrySend(3);
        Assert.Equal(3, ch.Length());
        Assert.Equal(8, ch.Capacity);
        Assert.False(ch.IsUnbounded);
    }

    [Fact]
    public void Unbounded_AcceptsManySends_WithoutBlocking()
    {
        var ch = Chan.Unbounded<int>();
        Assert.True(ch.IsUnbounded);
        Assert.Equal(int.MaxValue, ch.Capacity);
        for (var i = 0; i < 10_000; i++)
        {
            Assert.True(ch.TrySend(i));
        }

        Assert.Equal(10_000, ch.Length());
        for (var i = 0; i < 10_000; i++)
        {
            Assert.True(ch.TryReceive(out var v, out var ok));
            Assert.True(ok);
            Assert.Equal(i, v);
        }
    }

    [Fact]
    public void Constructor_RejectsNegativeCapacity()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new Chan<int>(-1));
    }

    [Fact]
    public void Close_Twice_Throws_ButDisposeIsIdempotent()
    {
        var ch = new Chan<int>(1);
        ch.Close();
        Assert.True(ch.IsClosed);
        Assert.Throws<ChannelClosedException>(() => ch.Close());
        Assert.False(ch.TryClose());
    }

    [Fact]
    public void Dispose_AfterClose_DoesNotThrow()
    {
        var ch = new Chan<int>(1);
        ch.Close();
        ch.Dispose();
        ch.Dispose();
        Assert.True(ch.IsClosed);
    }

    [Fact]
    public void Dispose_ClosesAnOpenChannel()
    {
        var ch = new Chan<int>(1);
        ch.TrySend(5);
        ch.Dispose();
        Assert.True(ch.IsClosed);
        Assert.Throws<ChannelClosedException>(() => ch.TrySend(6));

        // Drains, then reports closed.
        Assert.True(ch.TryReceive(out var v, out var ok) && ok && v == 5);
        Assert.True(ch.TryReceive(out _, out ok));
        Assert.False(ok);
    }

    [Fact]
    public async Task Send_OnClosedChannel_Throws()
    {
        var ch = new Chan<int>(1);
        ch.Close();
        Assert.Throws<ChannelClosedException>(() => ch.TrySend(1));
        var pending = ch.SendAsync(1);
        Assert.True(pending.IsFaulted);
        await Assert.ThrowsAsync<ChannelClosedException>(async () => await pending);
    }

    [Fact]
    public async Task ReceiveAsync_ParkedThenSend_Completes()
    {
        var ch = new Chan<int>(1);
        var receive = ch.ReceiveAsync().AsTask();
        Assert.False(receive.IsCompleted);
        Assert.Equal(1, ch.RegisteredWaiterCount);

        Assert.True(ch.TrySend(42));
        var result = await receive.WaitAsync(Timeout);
        Assert.True(result.Ok);
        Assert.Equal(42, result.Value);
        Assert.Equal(0, ch.RegisteredWaiterCount);
    }

    [Fact]
    public async Task SendAsync_ParkedOnFullBuffer_CompletesWhenSlotFrees()
    {
        var ch = new Chan<int>(1);
        Assert.True(ch.TrySend(1));
        var send = ch.SendAsync(2).AsTask();
        Assert.False(send.IsCompleted);

        Assert.True(ch.TryReceive(out var first, out _));
        Assert.Equal(1, first);
        await send.WaitAsync(Timeout);
        Assert.True(ch.TryReceive(out var second, out _));
        Assert.Equal(2, second);
    }

    [Fact]
    public async Task ParkedReceivers_WakeInFifoOrder()
    {
        var ch = new Chan<int>();
        var order = new List<int>();
        var receives = new List<Task<ReceiveResult<int>>>();
        for (var i = 0; i < 5; i++)
        {
            receives.Add(ch.ReceiveAsync().AsTask());
        }

        for (var i = 0; i < 5; i++)
        {
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
        }

        for (var i = 0; i < 5; i++)
        {
            order.Add((await receives[i].WaitAsync(Timeout)).Value);
        }

        Assert.Equal(new[] { 0, 1, 2, 3, 4 }, order);
    }

    [Fact]
    public async Task ParkedSenders_WakeInFifoOrder()
    {
        var ch = new Chan<int>();
        var sends = new List<Task>();
        for (var i = 0; i < 5; i++)
        {
            sends.Add(ch.SendAsync(i).AsTask());
        }

        var received = new List<int>();
        for (var i = 0; i < 5; i++)
        {
            received.Add((await ch.ReceiveAsync().AsTask().WaitAsync(Timeout)).Value);
        }

        await Task.WhenAll(sends).WaitAsync(Timeout);
        Assert.Equal(new[] { 0, 1, 2, 3, 4 }, received);
    }

    [Fact]
    public async Task Close_WithParkedReceivers_DeliversClosed_AndFaultsParkedSenders()
    {
        var ch = new Chan<int>();
        var receive = ch.ReceiveAsync().AsTask();
        var full = new Chan<int>(1);
        full.TrySend(1);
        var send = full.SendAsync(2).AsTask();

        ch.Close();
        var result = await receive.WaitAsync(Timeout);
        Assert.False(result.Ok);
        Assert.Equal(0, result.Value);

        full.Close();
        await Assert.ThrowsAsync<ChannelClosedException>(() => send.WaitAsync(Timeout));
    }

    [Fact]
    public async Task ReceiveAsync_CancelledWhilePending_Throws_AndUnparks()
    {
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource();
        var receive = ch.ReceiveAsync(cts.Token).AsTask();
        Assert.Equal(1, ch.RegisteredWaiterCount);
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => receive.WaitAsync(Timeout));
        Assert.Equal(0, ch.RegisteredWaiterCount);
    }

    [Fact]
    public async Task ReceiveAsync_AlreadyCancelledToken_ThrowsWithoutParking()
    {
        var ch = new Chan<int>();
        var receive = ch.ReceiveAsync(new CancellationToken(canceled: true));
        Assert.True(receive.IsCanceled);
        await Assert.ThrowsAsync<TaskCanceledException>(() => receive.AsTask());
        Assert.Equal(0, ch.RegisteredWaiterCount);
    }

    [Fact]
    public async Task ReceiveAsync_CancelRacingSend_NeverLosesValue()
    {
        // ADR-0174 D7 linearization rule: cancellation wins only before the
        // transfer commits. Every iteration either delivers the value to the
        // receiver or leaves it in the channel — never neither, never both.
        const int Iterations = 10_000;
        var delivered = 0;
        var cancelled = 0;
        for (var i = 0; i < Iterations; i++)
        {
            var ch = new Chan<int>(1);
            using var cts = new CancellationTokenSource();
            var receive = ch.ReceiveAsync(cts.Token);
            Assert.False(receive.IsCompleted);
            var pending = receive.AsTask();

            using var barrier = new Barrier(2);
            var sender = Task.Run(() =>
            {
                barrier.SignalAndWait();
                ch.TrySend(i);
            });
            var canceller = Task.Run(() =>
            {
                barrier.SignalAndWait();
                cts.Cancel();
            });
            await Task.WhenAll(sender, canceller).WaitAsync(Timeout);

            try
            {
                var result = await pending.WaitAsync(Timeout);
                Assert.True(result.Ok);
                Assert.Equal(i, result.Value);
                Assert.Equal(0, ch.Length());
                delivered++;
            }
            catch (OperationCanceledException)
            {
                Assert.True(ch.TryReceive(out var v, out var ok));
                Assert.True(ok);
                Assert.Equal(i, v);
                cancelled++;
            }
        }

        Assert.Equal(Iterations, delivered + cancelled);

        // Vacuity guard (ADR-0154): the race must actually have gone both ways.
        Assert.True(delivered > 0, "cancellation always won; the race was not exercised");
        Assert.True(cancelled > 0, "the send always won; the race was not exercised");
    }

    [Fact]
    public async Task ClosedReceive_RaisesNoFirstChanceException()
    {
        var ch = new Chan<int>(1);
        ch.Close();
        var closedExceptions = 0;
        EventHandler<FirstChanceExceptionEventArgs> handler = (_, e) =>
        {
            if (e.Exception is ChannelClosedException)
            {
                Interlocked.Increment(ref closedExceptions);
            }
        };

        AppDomain.CurrentDomain.FirstChanceException += handler;
        try
        {
            for (var i = 0; i < 1_000; i++)
            {
                Assert.True(ch.TryReceive(out _, out var ok));
                Assert.False(ok);
                var result = await ch.ReceiveAsync();
                Assert.False(result.Ok);
            }
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= handler;
        }

        Assert.Equal(0, closedExceptions);
    }

    [Fact]
    public async Task HappensBefore_FieldWrittenBeforeSend_IsVisibleAfterReceive()
    {
        const int Iterations = 200_000;
        var ch = new Chan<Payload>(4);
        var producer = Task.Run(async () =>
        {
            for (var i = 0; i < Iterations; i++)
            {
                var p = new Payload();
                p.Plain = i + 1;
                p.Second = -(i + 1);
                await ch.SendAsync(p);
            }

            ch.Close();
        });

        var mismatches = 0;
        var seen = 0;
        while (true)
        {
            var result = await ch.ReceiveAsync();
            if (!result.Ok)
            {
                break;
            }

            seen++;
            if (result.Value.Plain != seen || result.Value.Second != -seen)
            {
                mismatches++;
            }
        }

        await producer.WaitAsync(Timeout);
        Assert.Equal(Iterations, seen);
        Assert.Equal(0, mismatches);
    }

    [Fact]
    public async Task PooledNodes_AreReusedAcrossParks_WithoutCrossTalk()
    {
        var ch = new Chan<int>();
        for (var i = 0; i < 1_000; i++)
        {
            var receive = ch.ReceiveAsync().AsTask();
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
            Assert.Equal(i, (await receive.WaitAsync(Timeout)).Value);
        }
    }

    private sealed class Payload
    {
        public int Plain;
        public int Second;
    }
}
