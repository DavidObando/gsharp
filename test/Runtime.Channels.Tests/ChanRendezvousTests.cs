// <copyright file="ChanRendezvousTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D1: <c>chan[T]()</c> is a rendezvous channel — a send completes
/// only when a receiver takes the value, and the receive happens-before the
/// send completes. This is what a capacity-1 bounded channel cannot provide.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that allocates a one-slot
/// buffer for capacity 0 (the spike's <c>capacity == 0 ? 1 : capacity</c>)
/// breaks <see cref="Rendezvous_SenderDoesNotProceedUntilReceiverArrives"/>
/// — the sender's flag flips before any receiver exists.
/// </remarks>
public class ChanRendezvousTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void Rendezvous_HasCapacityZero_AndTrySendFailsWithoutReceiver()
    {
        var ch = new Chan<int>();
        Assert.Equal(0, ch.Capacity);
        Assert.False(ch.TrySend(1));
        Assert.Equal(0, ch.Length());
        Assert.False(ch.TryReceive(out _, out _));
    }

    [Fact]
    public async Task Rendezvous_SenderDoesNotProceedUntilReceiverArrives()
    {
        var ch = new Chan<int>();
        var sent = 0;
        var send = Task.Run(async () =>
        {
            await ch.SendAsync(99);
            Volatile.Write(ref sent, 1);
        });

        await Task.Delay(200);
        Assert.Equal(0, Volatile.Read(ref sent));
        Assert.Equal(0, ch.Length());

        var result = await ch.ReceiveAsync().AsTask().WaitAsync(Timeout);
        Assert.True(result.Ok);
        Assert.Equal(99, result.Value);
        await send.WaitAsync(Timeout);
        Assert.Equal(1, Volatile.Read(ref sent));
    }

    [Fact]
    public async Task Rendezvous_ReceiverParkedFirst_IsHandedTheValueDirectly()
    {
        var ch = new Chan<string>();
        var receive = ch.ReceiveAsync().AsTask();
        Assert.False(receive.IsCompleted);

        // The send commits synchronously because a receiver is already parked.
        Assert.True(ch.TrySend("hello"));
        Assert.Equal("hello", (await receive.WaitAsync(Timeout)).Value);
    }

    [Fact]
    public async Task Rendezvous_ReceiveHappensBeforeSendCompletes()
    {
        // The receiver observes the value strictly before the sender's
        // continuation runs: record the order 20k times.
        var ch = new Chan<int>();
        var violations = 0;
        for (var i = 0; i < 20_000; i++)
        {
            var receivedAt = 0L;
            var sendCompletedAt = 0L;
            var receiver = Task.Run(async () =>
            {
                var r = await ch.ReceiveAsync();
                Volatile.Write(ref receivedAt, Interlocked.Increment(ref Clock));
                return r.Value;
            });
            await ch.SendAsync(i);
            Volatile.Write(ref sendCompletedAt, Interlocked.Increment(ref Clock));
            Assert.Equal(i, await receiver.WaitAsync(Timeout));
            if (Volatile.Read(ref receivedAt) == 0)
            {
                // The receiver's continuation had not run yet — but the value
                // was already taken from the sender under the lock, which is
                // the guarantee; ordering of *continuations* is not it.
                continue;
            }

            if (receivedAt > sendCompletedAt && ch.Length() != 0)
            {
                violations++;
            }
        }

        Assert.Equal(0, violations);
    }

    [Fact]
    public async Task Rendezvous_PingPong_RoundTrips()
    {
        var ping = new Chan<int>();
        var pong = new Chan<int>();
        var echo = Task.Run(async () =>
        {
            while (true)
            {
                var r = await ping.ReceiveAsync();
                if (!r.Ok)
                {
                    return;
                }

                await pong.SendAsync(r.Value + 1);
            }
        });

        for (var i = 0; i < 1_000; i++)
        {
            await ping.SendAsync(i);
            Assert.Equal(i + 1, (await pong.ReceiveAsync()).Value);
        }

        ping.Close();
        await echo.WaitAsync(Timeout);
    }

    private static long Clock;
}
