// <copyright file="SelectWaiterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D8 protocol facts for <see cref="SelectWaiter"/> that are
/// deterministic: arm selection, value transfer, generation guard, loser
/// deregistration, closed-channel arms, cancellation with and without a
/// <c>cancelled</c> arm, task arms, foreign-arm readiness, and gate ordering.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154, mutants applied to
/// <c>src/Sdk/Gsharp.Runtime.Channels/SelectWaiter.cs</c>): removing the
/// generation increment from <c>Begin</c> breaks <see cref="TryClaim_StaleGeneration_IsRejected"/>;
/// deleting the <c>Deregister</c> loop from <c>Return</c> breaks
/// <see cref="Return_DeregistersLosers"/>; sorting gates descending (or not
/// at all) breaks <see cref="CollectGates_SortsAscendingById_AndDedupes"/>;
/// completing the waiter with the cancellation without the CAS breaks
/// <see cref="Cancellation_AfterClaim_IsIgnored"/>.
/// </remarks>
public class SelectWaiterTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task ReadyArm_UnderLocks_CompletesSynchronously_WithValue()
    {
        var a = new Chan<int>(1);
        var b = new Chan<int>(1);
        b.TrySend(42);
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<int>(a, 0);
        w.AddReceive<int>(b, 1);
        var wait = w.WaitAsync();
        Assert.True(wait.IsCompletedSuccessfully);
        Assert.Equal(1, await wait);
        Assert.True(w.Ok);
        Assert.False(w.NeedsReprobe);
        Assert.Equal(42, w.TakeValue<int>());
        w.Return();
        Assert.Equal(0, a.RegisteredWaiterCount);
        Assert.Equal(0, b.RegisteredWaiterCount);
    }

    [Fact]
    public async Task ParkedThenSend_WinsThatArm_AndTransfersExactlyOnce()
    {
        var a = new Chan<string>();
        var b = new Chan<string>();
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<string>(a, 0);
        w.AddReceive<string>(b, 1);
        var wait = w.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);
        Assert.Equal(1, a.RegisteredWaiterCount);
        Assert.Equal(1, b.RegisteredWaiterCount);

        // The send commits directly into the select — the value is never buffered.
        Assert.True(b.TrySend("hello"));
        Assert.Equal(1, await wait.WaitAsync(Timeout));
        Assert.Equal("hello", w.TakeValue<string>());
        Assert.Equal(0, b.Length());
        w.Return();
        Assert.Equal(0, a.RegisteredWaiterCount);
    }

    [Fact]
    public async Task Return_DeregistersLosers()
    {
        var a = new Chan<int>();
        var b = new Chan<int>();
        var c = new Chan<int>();
        var w = SelectWaiter.Rent(3, CancellationToken.None);
        w.AddReceive<int>(a, 0);
        w.AddReceive<int>(b, 1);
        w.AddSend<int>(c, 5, 2);
        var wait = w.WaitAsync().AsTask();
        Assert.Equal(1, a.RegisteredWaiterCount);
        Assert.Equal(1, b.RegisteredWaiterCount);
        Assert.Equal(1, c.RegisteredWaiterCount);
        a.TrySend(1);
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        w.Return();
        Assert.Equal(0, a.RegisteredWaiterCount + b.RegisteredWaiterCount + c.RegisteredWaiterCount);
    }

    [Fact]
    public async Task TryClaim_StaleGeneration_IsRejected()
    {
        var ch = new Chan<int>();
        var w = SelectWaiter.Rent(1, CancellationToken.None);
        w.AddReceive<int>(ch, 0);
        var wait = w.WaitAsync().AsTask();
        var stale = w.Generation;
        ch.TrySend(1);
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        w.Return();

        var reused = SelectWaiter.Rent(1, CancellationToken.None);
        Assert.Same(w, reused);
        Assert.Equal(stale + 1, reused.Generation);
        Assert.False(reused.TryClaim(stale, 7));
        Assert.True(reused.TryClaim(reused.Generation, 3));
        Assert.False(reused.TryClaim(reused.Generation, 4));
        reused.Return();
    }

    [Fact]
    public async Task SendArm_OnRendezvous_HandsValueToArrivingReceiver()
    {
        var ch = new Chan<int>();
        var never = new Chan<int>();
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddSend<int>(ch, 77, 0);
        w.AddReceive<int>(never, 1);
        var wait = w.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);

        var received = await ch.ReceiveAsync().AsTask().WaitAsync(Timeout);
        Assert.Equal(77, received.Value);
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        w.Return();
    }

    [Fact]
    public async Task ClosedChannel_ReceiveArm_FiresWithZero_AndOkFalse()
    {
        var ch = new Chan<int>();
        var never = new Chan<int>();
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<int>(ch, 0);
        w.AddReceive<int>(never, 1);
        var wait = w.WaitAsync().AsTask();
        ch.Close();
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        Assert.False(w.Ok);
        Assert.Equal(0, w.TakeValue<int>());
        w.Return();

        // Already closed at probe time: same outcome, synchronously.
        var w2 = SelectWaiter.Rent(1, CancellationToken.None);
        w2.AddReceive<int>(ch, 0);
        var wait2 = w2.WaitAsync();
        Assert.True(wait2.IsCompletedSuccessfully);
        Assert.False(w2.Ok);
        w2.Return();
    }

    [Fact]
    public async Task ClosedChannel_SendArm_Throws()
    {
        var ch = new Chan<int>();
        var never = new Chan<int>();
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddSend<int>(ch, 1, 0);
        w.AddReceive<int>(never, 1);
        var wait = w.WaitAsync().AsTask();
        ch.Close();
        await Assert.ThrowsAsync<ChannelClosedException>(() => wait.WaitAsync(Timeout));
        w.Return();

        var w2 = SelectWaiter.Rent(1, CancellationToken.None);
        w2.AddSend<int>(ch, 1, 0);
        await Assert.ThrowsAsync<ChannelClosedException>(async () => await w2.WaitAsync());
        w2.Return();
    }

    [Fact]
    public async Task Cancellation_WithoutCancelledArm_Throws_AndDeregisters()
    {
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource();
        var w = SelectWaiter.Rent(1, cts.Token);
        w.AddReceive<int>(ch, 0);
        var wait = w.WaitAsync().AsTask();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => wait.WaitAsync(Timeout));
        w.Return();
        Assert.Equal(0, ch.RegisteredWaiterCount);
    }

    [Fact]
    public async Task Cancellation_WithCancelledArm_SelectsIt()
    {
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource();
        var w = SelectWaiter.Rent(2, cts.Token);
        w.AddReceive<int>(ch, 0);
        w.AddCancelled(1);
        var wait = w.WaitAsync().AsTask();
        cts.Cancel();
        Assert.Equal(1, await wait.WaitAsync(Timeout));
        w.Return();

        // Already cancelled at probe time: taken synchronously.
        var w2 = SelectWaiter.Rent(2, cts.Token);
        w2.AddReceive<int>(ch, 0);
        w2.AddCancelled(1);
        var wait2 = w2.WaitAsync();
        Assert.True(wait2.IsCompletedSuccessfully);
        Assert.Equal(1, await wait2);
        w2.Return();
    }

    [Fact]
    public async Task Cancellation_AfterClaim_IsIgnored()
    {
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource();
        var w = SelectWaiter.Rent(1, cts.Token);
        w.AddReceive<int>(ch, 0);
        var wait = w.WaitAsync().AsTask();
        Assert.True(ch.TrySend(9));
        cts.Cancel();
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        Assert.Equal(9, w.TakeValue<int>());
        w.Return();
    }

    [Fact]
    public async Task TaskArm_Wins_WithResult_AndFaultPropagates()
    {
        var never = new Chan<int>();
        var tcs = new TaskCompletionSource<string>();
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<int>(never, 0);
        w.AddTask(tcs.Task, 1);
        var wait = w.WaitAsync().AsTask();
        tcs.SetResult("done");
        Assert.Equal(1, await wait.WaitAsync(Timeout));
        Assert.Equal("done", w.TakeValue<string>());
        w.Return();

        var faulted = new TaskCompletionSource<string>();
        var w2 = SelectWaiter.Rent(2, CancellationToken.None);
        w2.AddReceive<int>(never, 0);
        w2.AddTask(faulted.Task, 1);
        var wait2 = w2.WaitAsync().AsTask();
        faulted.SetException(new InvalidOperationException("boom"));
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => wait2.WaitAsync(Timeout));
        Assert.Equal("boom", ex.Message);
        w2.Return();

        // Completed before registration: synchronous.
        var w3 = SelectWaiter.Rent(1, CancellationToken.None);
        w3.AddTask(Task.FromResult(5), 0);
        Assert.Equal(0, await w3.WaitAsync());
        Assert.Equal(5, w3.TakeValue<int>());
        w3.Return();
    }

    [Fact]
    public async Task ForeignArm_SignalsReadiness_WithNeedsReprobe()
    {
        var foreign = Channel.CreateBounded<int>(1);
        var never = new Chan<int>();
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<int>(foreign, 0);
        w.AddReceive<int>(never, 1);
        var wait = w.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);
        await foreign.Writer.WriteAsync(3);
        Assert.Equal(0, await wait.WaitAsync(Timeout));
        Assert.True(w.NeedsReprobe);
        w.Return();

        // Re-probe finds the item.
        Assert.True(foreign.Reader.TryRead(out var v));
        Assert.Equal(3, v);

        // Closed foreign channel: the arm fires closed (no re-probe needed).
        foreign.Writer.Complete();
        var w2 = SelectWaiter.Rent(1, CancellationToken.None);
        w2.AddReceive<int>(foreign, 0);
        Assert.Equal(0, await w2.WaitAsync());
        Assert.False(w2.Ok);
        Assert.False(w2.NeedsReprobe);
        w2.Return();
    }

    [Fact]
    public async Task NilArms_AreDisabled()
    {
        var ch = new Chan<int>(1);
        ch.TrySend(1);
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<int>((Channel<int>?)null, 0);
        w.AddSend<int>((ChannelWriter<int>?)null, 5, 1);
        w.AddReceive<int>(ch, 2);
        Assert.Equal(1, w.ArmCount);
        Assert.Equal(2, await w.WaitAsync());
        w.Return();
    }

    [Fact]
    public void CollectGates_SortsAscendingById_AndDedupes()
    {
        var first = new Chan<int>();
        var second = new Chan<int>();
        var third = new Chan<string>();
        Assert.True(first.Id < second.Id && second.Id < third.Id);

        var w = SelectWaiter.Rent(4, CancellationToken.None);
        w.AddReceive<string>(third, 0);
        w.AddReceive<int>(second, 1);
        w.AddReceive<int>(first, 2);
        w.AddSend<int>(second, 1, 3);
        var gates = w.CollectGates();
        Assert.Equal(new[] { first.Id, second.Id, third.Id }, gates.Select(g => g.Order).ToArray());
        w.Return();
    }

    [Fact]
    public async Task SameChannel_ReceiveAndSend_ArmsCoexist()
    {
        // The same channel in two arms locks once and both register.
        var ch = new Chan<int>(1);
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive<int>(ch, 0);
        w.AddSend<int>(ch, 1, 1);
        Assert.Equal(1, await w.WaitAsync());
        Assert.Equal(1, ch.Length());
        w.Return();
    }

    [Fact]
    public void SelectRandom_Shuffle_IsAPermutation_AndReseedIsReproducible()
    {
        SelectRandom.Reseed(1234);
        var a = SelectRandom.Shuffle(10).ToArray();
        Assert.Equal(Enumerable.Range(0, 10), a.OrderBy(x => x));
        SelectRandom.Reseed(1234);
        var b = SelectRandom.Shuffle(10).ToArray();
        Assert.Equal(a, b);
        Assert.Empty(SelectRandom.Shuffle(0).ToArray());

        var seen = new HashSet<int>();
        for (var i = 0; i < 1000; i++)
        {
            seen.Add(SelectRandom.Next(3));
        }

        Assert.Equal(new[] { 0, 1, 2 }, seen.OrderBy(x => x));
    }
    [Fact]
    public void TryNow_WithCancelledArm_TakesItWhenAlreadyCancelled()
    {
        // The `default` path probes without registering or parking. An
        // already-cancelled context is a ready arm — Go's `ctx.Done()` is a
        // ready channel — so `default` must not win over it (ADR-0174 D8).
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var w = SelectWaiter.Rent(2, cts.Token);
        w.AddReceive<int>(ch, 0);
        w.AddCancelled(1);
        Assert.Equal(1, w.TryNow());
        w.Return();
    }

    [Fact]
    public void TryNow_WithCancelledArm_ReportsNothingReadyWhileLive()
    {
        var ch = new Chan<int>();
        using var cts = new CancellationTokenSource();
        var w = SelectWaiter.Rent(2, cts.Token);
        w.AddReceive<int>(ch, 0);
        w.AddCancelled(1);
        Assert.Equal(-1, w.TryNow());
        w.Return();
    }

    [Fact]
    public void TryNow_PrefersAReadyChannel_OverAnAlreadyCancelledContext()
    {
        // Deliberate, and the same rule the parking path already follows: the
        // gated channel arms are probed first, and cancellation is consulted
        // only when nothing else can make progress. A select that can do its
        // work does it rather than bail out.
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        for (var i = 0; i < 200; i++)
        {
            var ch = new Chan<int>(1);
            ch.Writer.TryWrite(7);
            var w = SelectWaiter.Rent(2, cts.Token);
            w.AddReceive<int>(ch, 0);
            w.AddCancelled(1);
            Assert.Equal(0, w.TryNow());
            w.Return();
        }
    }
}
