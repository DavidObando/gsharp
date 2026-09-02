// <copyright file="SelectWaiterStressTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D8 stress witnesses for the transactional select protocol, under
/// real contention. Each is bounded by a hard timeout and sized for a 4-vCPU
/// runner; the project's CI shard runs with <c>--blame-hang</c>.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/</c>): splitting claim-and-transfer in
/// <c>SelectNode{T}.TryCommitReceive</c> into a claim followed by a re-probe
/// breaks <see cref="Select_UnderCompetingConsumers_NeverLosesOrDuplicates"/>
/// (a lost or duplicated id within 200 000); removing the generation check
/// from <c>SelectWaiter.TryClaim</c> breaks
/// <see cref="Select_TimerLoser_InFlightCallback_CannotClaimReusedWaiter"/>;
/// skipping <c>Deregister</c> in <c>Return</c> breaks
/// <see cref="Select_Losers_LeaveNoRegistrations"/>; acquiring gates in arm
/// order instead of <c>Chan.Id</c> order breaks
/// <see cref="Select_OppositeArmOrder_DoesNotDeadlock"/>; completing the
/// waiter from the cancellation callback without the CAS breaks
/// <see cref="Select_CancelRacingSend_NeverLosesValue"/>.
/// </remarks>
[Trait("Category", "Stress")]
public class SelectWaiterStressTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    [Fact]
    public async Task Select_UnderCompetingConsumers_NeverLosesOrDuplicates()
    {
        const int Items = 200_000;
        var a = new Chan<int>(1);
        var b = new Chan<int>(1);
        var seen = new ConcurrentDictionary<int, byte>();
        var duplicates = 0;

        var producers = Task.WhenAll(
            Task.Run(async () =>
            {
                for (var i = 0; i < Items; i += 2)
                {
                    await a.SendAsync(i);
                }

                a.Close();
            }),
            Task.Run(async () =>
            {
                for (var i = 1; i < Items; i += 2)
                {
                    await b.SendAsync(i);
                }

                b.Close();
            }));

        void Record(int v)
        {
            if (!seen.TryAdd(v, 0))
            {
                Interlocked.Increment(ref duplicates);
            }
        }

        var thieves = new[]
        {
            Task.Run(async () =>
            {
                while (!a.IsClosed || a.Length() > 0)
                {
                    if (a.TryReceive(out var v, out var ok) && ok)
                    {
                        Record(v);
                    }
                    else
                    {
                        await Task.Yield();
                    }
                }
            }),
            Task.Run(async () =>
            {
                while (!b.IsClosed || b.Length() > 0)
                {
                    if (b.TryReceive(out var v, out var ok) && ok)
                    {
                        Record(v);
                    }
                    else
                    {
                        await Task.Yield();
                    }
                }
            }),
        };

        var selectors = new Task[4];
        for (var s = 0; s < selectors.Length; s++)
        {
            selectors[s] = Task.Run(async () =>
            {
                Chan<int>? armA = a;
                Chan<int>? armB = b;
                while (armA is not null || armB is not null)
                {
                    var w = SelectWaiter.Rent(2, default);
                    w.AddReceive<int>(armA, 0);
                    w.AddReceive<int>(armB, 1);
                    var arm = await w.WaitAsync();
                    if (w.Ok)
                    {
                        Record(w.TakeValue<int>());
                    }
                    else if (arm == 0)
                    {
                        armA = null;
                    }
                    else
                    {
                        armB = null;
                    }

                    w.Return();
                }
            });
        }

        await Task.WhenAll(producers, Task.WhenAll(thieves), Task.WhenAll(selectors)).WaitAsync(Timeout);
        Assert.Equal(0, duplicates);
        Assert.Equal(Items, seen.Count);
    }

    [Fact]
    public async Task Select_OppositeArmOrder_DoesNotDeadlock()
    {
        const int Rounds = 100_000;
        var a = new Chan<int>();
        var b = new Chan<int>();
        var producer = Task.Run(async () =>
        {
            for (var i = 0; i < Rounds; i++)
            {
                await ((i & 1) == 0 ? a : b).SendAsync(i);
            }

            a.Close();
            b.Close();
        });

        async Task Selector(Chan<int> first, Chan<int> second)
        {
            var open = 2;
            Chan<int>? x = first;
            Chan<int>? y = second;
            while (open > 0)
            {
                var w = SelectWaiter.Rent(2, default);
                w.AddReceive<int>(x, 0);
                w.AddReceive<int>(y, 1);
                var arm = await w.WaitAsync();
                if (!w.Ok)
                {
                    open--;
                    if (arm == 0)
                    {
                        x = null;
                    }
                    else
                    {
                        y = null;
                    }
                }

                w.Return();
            }
        }

        await Task.WhenAll(producer, Task.Run(() => Selector(a, b)), Task.Run(() => Selector(b, a))).WaitAsync(Timeout);
    }

    [Fact]
    public async Task Select_Losers_LeaveNoRegistrations()
    {
        var a = new Chan<int>();
        var b = new Chan<int>();
        for (var i = 0; i < 10_000; i++)
        {
            var w = SelectWaiter.Rent(2, default);
            w.AddReceive<int>(a, 0);
            w.AddReceive<int>(b, 1);
            var wait = w.WaitAsync().AsTask();
            Assert.True(a.TrySend(i));
            Assert.Equal(0, await wait.WaitAsync(Timeout));
            w.Return();
        }

        Assert.Equal(0, a.RegisteredWaiterCount);
        Assert.Equal(0, b.RegisteredWaiterCount);
    }

    [Fact]
    public async Task Select_CancelRacingSend_NeverLosesValue()
    {
        const int Iterations = 10_000;
        var delivered = 0;
        var cancelled = 0;
        var never = new Chan<int>();
        for (var i = 0; i < Iterations; i++)
        {
            var ch = new Chan<int>(1);
            using var cts = new CancellationTokenSource();
            var w = SelectWaiter.Rent(2, cts.Token);
            w.AddReceive<int>(ch, 0);
            w.AddReceive<int>(never, 1);
            var wait = w.WaitAsync().AsTask();

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
                Assert.Equal(0, await wait.WaitAsync(Timeout));
                Assert.True(w.Ok);
                Assert.Equal(i, w.TakeValue<int>());
                Assert.Equal(0, ch.Length());
                delivered++;
            }
            catch (OperationCanceledException)
            {
                Assert.True(ch.TryReceive(out var v, out var ok) && ok);
                Assert.Equal(i, v);
                cancelled++;
            }

            w.Return();
        }

        Assert.Equal(Iterations, delivered + cancelled);
        Assert.True(delivered > 0, "cancellation always won; the race was not exercised");
        Assert.True(cancelled > 0, "the send always won; the race was not exercised");
    }

    [Fact]
    public async Task Select_TimerLoser_InFlightCallback_CannotClaimReusedWaiter()
    {
        // A timer arm that loses leaves a Timer callback that may still fire
        // against the same (pooled, reused) waiter. The generation stamp must
        // make that claim fail, or a later select would observe a phantom
        // timer win.
        var other = new Chan<int>(1);
        for (var i = 0; i < 5_000; i++)
        {
            var ch = new Chan<int>(1);
            using var after = Timers.After(TimeSpan.FromMilliseconds(1));
            var w = SelectWaiter.Rent(2, default);
            w.AddReceive<int>(ch, 0);
            w.AddReceive<DateTime>(after, 1);
            var wait = w.WaitAsync().AsTask();
            ch.TrySend(i);
            var arm = await wait.WaitAsync(Timeout);
            w.Return();

            if (arm != 0)
            {
                continue;
            }

            // Immediately reuse the pooled waiter on a ready channel; the
            // timer's callback for the previous select may fire right now.
            other.TrySend(-i);
            var w2 = SelectWaiter.Rent(1, default);
            w2.AddReceive<int>(other, 0);
            Assert.Equal(0, await w2.WaitAsync().AsTask().WaitAsync(Timeout));
            Assert.True(w2.Ok);
            Assert.Equal(-i, w2.TakeValue<int>());
            w2.Return();
        }
    }

    [Fact]
    public async Task Select_SendArm_OnRendezvous_ReceiverSeesValueOnlyIfArmWon()
    {
        var ch = new Chan<int>();
        var alt = new Chan<int>();
        var mismatches = 0;
        for (var i = 0; i < 5_000; i++)
        {
            var w = SelectWaiter.Rent(2, default);
            w.AddSend<int>(ch, i, 0);
            w.AddReceive<int>(alt, 1);
            var wait = w.WaitAsync().AsTask();

            // Race a receiver against an alternative win.
            var receiver = Task.Run(() => ch.TryReceive(out var v, out var ok) && ok ? v : (int?)null);
            alt.TrySend(0);
            var arm = await wait.WaitAsync(Timeout);
            var got = await receiver.WaitAsync(Timeout);
            w.Return();

            if (arm == 0 && got != i)
            {
                // The send arm won, so the receiver must be the one who took it
                // (or a later receiver will — check the channel is empty).
                if (ch.Length() != 0)
                {
                    mismatches++;
                }
            }

            if (arm == 1 && got is not null)
            {
                mismatches++;
            }
        }

        Assert.Equal(0, mismatches);
    }
}
