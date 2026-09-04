// <copyright file="Issue3902InlineCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Issue #3902 (H1) / ADR-0174 gate G6: a hand-off completes its waiter's
/// continuation on the publishing thread when the inline budget allows,
/// instead of queueing a thread-pool work item for another thread to steal.
/// </summary>
/// <remarks>
/// The performance case is measured by the concurrency benchmark. These tests
/// exist for the four ways inline completion can be WRONG, each of which is
/// silent under every pre-existing test.
/// <list type="number">
/// <item>A blocking channel operation is what <c>lock { ch &lt;- v }</c>
/// compiles to. Monitor is reentrant, so an inline continuation would run
/// inside the caller's lock and observe mutual exclusion it does not hold —
/// <see cref="BlockingSend_DoesNotRunAContinuationInsideTheCallersLock"/>.</item>
/// <item>The continuation runs while <c>SetResult</c> is still on the stack, so
/// a node returned to its pool from inside <c>GetResult</c> is re-rented within
/// the publisher's own frame —
/// <see cref="InlineContinuation_MayReRentTheSameNode"/>.</item>
/// <item>Nesting is bounded, or a chain of hand-offs grows the stack per link —
/// <see cref="DeepHandoffChain_CompletesWithoutExhaustingTheStack"/>.</item>
/// <item>A cancellation callback must not run user code on the cancelling
/// thread — <see cref="CancelledSelect_DoesNotRunItsContinuationOnTheCancellingThread"/>.</item>
/// </list>
/// </remarks>
public class Issue3902InlineCompletionTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task BlockingSend_DoesNotRunAContinuationInsideTheCallersLock()
    {
        var gate = new object();
        var ch = new Chan<int>(0);
        var observedInsideLock = false;
        var receiverReady = new SemaphoreSlim(0);

        var receiver = Task.Run(async () =>
        {
            receiverReady.Release();
            await ch.ReceiveValueAsync().AsTask().ConfigureAwait(false);

            // If the sender published inline, this continuation is running on
            // the sender's stack, inside its lock.
            observedInsideLock = Monitor.IsEntered(gate);
        });

        await receiverReady.WaitAsync(Timeout);
        await Task.Delay(50);

        lock (gate)
        {
            ChannelOps.Send(ch, 1, default(CancellationToken));
        }

        await receiver.WaitAsync(Timeout);
        Assert.False(
            observedInsideLock,
            "a receive continuation ran inside the sending thread's monitor. A blocking channel "
            + "operation is a `lock { ch <- v }` body, and Monitor's reentrancy makes that silently "
            + "wrong (issue #3902 H1).");
    }

    [Fact]
    public async Task InlineContinuation_MayReRentTheSameNode()
    {
        // The continuation runs before SetResult has returned, and consuming the
        // result returns the node to the channel's single-slot cache. Re-renting
        // it from inside that frame is the sharpest version of the reuse, and it
        // must produce a fresh version token rather than replay the old result.
        var ch = new Chan<int>(0);
        var results = new int[8];

        var consumer = Task.Run(async () =>
        {
            for (var i = 0; i < results.Length; i++)
            {
                results[i] = await ch.ReceiveValueAsync().ConfigureAwait(false);
            }
        });

        for (var i = 0; i < results.Length; i++)
        {
            await ch.SendAsync(i + 1).AsTask().WaitAsync(Timeout);
        }

        await consumer.WaitAsync(Timeout);
        Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7, 8 }, results);
    }

    [Fact]
    public async Task DeepHandoffChain_CompletesWithoutExhaustingTheStack()
    {
        // Each link's receive completes the previous link's send, so an
        // unbounded inline budget would nest one frame per link. The gate's
        // stack test: it must complete, not merely avoid crashing.
        const int Links = 10_000;
        var ch = new Chan<int>(0);
        var total = 0L;

        var consumer = Task.Run(async () =>
        {
            for (var i = 0; i < Links; i++)
            {
                total += await ch.ReceiveValueAsync().ConfigureAwait(false);
            }
        });

        for (var i = 1; i <= Links; i++)
        {
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
        }

        await consumer.WaitAsync(Timeout);
        Assert.Equal(Links * (Links + 1L) / 2, total);
    }

    [Fact]
    public async Task CancelledSelect_DoesNotRunItsContinuationOnTheCancellingThread()
    {
        using var cts = new CancellationTokenSource();
        var ch = new Chan<int>(0);
        var cancellingThread = 0;
        var continuationThread = 0;

        var w = SelectWaiter.Rent(1, cts.Token);
        w.AddReceive(ch, 0);
        var wait = w.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);

        var observer = wait.ContinueWith(
            _ => continuationThread = Environment.CurrentManagedThreadId,
            TaskContinuationOptions.ExecuteSynchronously);

        cancellingThread = Environment.CurrentManagedThreadId;
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => wait.WaitAsync(Timeout));
        await observer.WaitAsync(Timeout);
        w.Return();

        Assert.NotEqual(cancellingThread, continuationThread);
    }

    [Fact]
    public async Task HandoffStillDelivers_WhenTheBudgetIsExhausted()
    {
        // Whatever the budget decides, the value must arrive. Drive far more
        // hand-offs than the depth limit through one channel.
        var ch = new Chan<int>(0);
        var seen = 0;
        var consumer = Task.Run(async () =>
        {
            while (true)
            {
                var (value, ok) = await ch.ReceiveTupleAsync().ConfigureAwait(false);
                if (!ok)
                {
                    return;
                }

                seen += value;
            }
        });

        for (var i = 0; i < 200; i++)
        {
            await ch.SendAsync(1).AsTask().WaitAsync(Timeout);
        }

        ch.Close();
        await consumer.WaitAsync(Timeout);
        Assert.Equal(200, seen);
    }
}
