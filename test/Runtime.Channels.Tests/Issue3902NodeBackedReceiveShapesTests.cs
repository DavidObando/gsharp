// <copyright file="Issue3902NodeBackedReceiveShapesTests.cs" company="GSharp">
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
/// Issue #3902 (S2): a suspending receive through the language is backed by the
/// waiter node itself in all three result shapes, rather than by an
/// <c>async</c> wrapper that reshapes <see cref="ReceiveResult{T}"/> after the
/// fact. The wrapper ran on the default builder, so every park boxed an
/// <c>AsyncStateMachineBox</c> — about 144 bytes — and inserted a Task
/// continuation between the node and the caller's state machine.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154). The product mutant for the allocation
/// claim is reverting S2 <em>entirely</em> in <c>ChannelOps.Awaited.cs</c> —
/// both the <c>is Chan&lt;T&gt;</c> dispatch and the pooling builder on the
/// wrapper — which
/// <see cref="ParkedReceive_ThroughTheLanguageSurface_AllocatesNothingPerOperation"/>
/// catches at 71.8 B/op against a 32 B threshold.
/// <para>
/// Measured, so the claim is not overstated: reverting the dispatch <em>alone</em>
/// does NOT fail that test. The allocation is removed by the pooling builder,
/// and what the dispatch additionally removes is the Task continuation between
/// the node and the caller's state machine — a latency effect this test cannot
/// see. That half is evidenced by the concurrency benchmark, not here.
/// </para>
/// <para>
/// A second mutant — dropping the pooling in <c>OpReceiveNode.TakeResult</c>,
/// or letting two of the three shapes each return the node — is caught by
/// <see cref="ParkedReceives_AcrossShapes_KeepReusingOneNode"/>. A node
/// returned twice is the failure this factoring exists to prevent.
/// </para>
/// </remarks>
public class Issue3902NodeBackedReceiveShapesTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task ParkedReceiveValue_DeliversTheValue()
    {
        var ch = new Chan<int>(0);
        var receive = ch.ReceiveValueAsync().AsTask();
        Assert.False(receive.IsCompleted);

        await ch.SendAsync(7).AsTask().WaitAsync(Timeout);
        Assert.Equal(7, await receive.WaitAsync(Timeout));
    }

    [Fact]
    public async Task ParkedReceiveTuple_DeliversTheValueAndOk()
    {
        var ch = new Chan<int>(0);
        var receive = ch.ReceiveTupleAsync().AsTask();

        await ch.SendAsync(9).AsTask().WaitAsync(Timeout);
        var (value, ok) = await receive.WaitAsync(Timeout);
        Assert.Equal(9, value);
        Assert.True(ok);
    }

    [Fact]
    public async Task ParkedShapes_OnClose_YieldTheDocumentedClosedResults()
    {
        // D3: the single-value shape yields the zero value, the two-value shape
        // says so explicitly. Both must hold for a receive already PARKED when
        // the close arrives, which is the path the node backs.
        var single = new Chan<int>(0);
        var pair = new Chan<int>(0);
        var singleReceive = single.ReceiveValueAsync().AsTask();
        var pairReceive = pair.ReceiveTupleAsync().AsTask();

        single.Close();
        pair.Close();

        Assert.Equal(0, await singleReceive.WaitAsync(Timeout));
        var (value, ok) = await pairReceive.WaitAsync(Timeout);
        Assert.Equal(0, value);
        Assert.False(ok);
    }

    [Fact]
    public async Task ClosedAndDrained_ShapesCompleteSynchronously()
    {
        var ch = new Chan<int>(1);
        ch.Close();

        var single = ch.ReceiveValueAsync();
        var pair = ch.ReceiveTupleAsync();
        Assert.True(single.IsCompletedSuccessfully);
        Assert.True(pair.IsCompletedSuccessfully);
        Assert.Equal(0, await single);
        Assert.Equal((0, false), await pair);
    }

    [Fact]
    public async Task ParkedShapes_Cancelled_ThrowOperationCanceled()
    {
        using var cts = new CancellationTokenSource();
        var ch = new Chan<int>(0);
        var single = ch.ReceiveValueAsync(cts.Token).AsTask();
        var pair = ch.ReceiveTupleAsync(cts.Token).AsTask();

        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => single.WaitAsync(Timeout));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pair.WaitAsync(Timeout));
    }

    [Fact]
    public async Task ParkedReceives_AcrossShapes_KeepReusingOneNode()
    {
        // The node cache is a single slot, so a node consumed through any shape
        // must come back to it. Interleaving the shapes is the point: if one of
        // them failed to pool, or pooled twice, the reuse count collapses or the
        // channel starts handing the same node to two waiters.
        var ch = new Chan<int>(0);
        for (var i = 0; i < 200; i++)
        {
            var single = ch.ReceiveValueAsync().AsTask();
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
            Assert.Equal(i, await single.WaitAsync(Timeout));

            var pair = ch.ReceiveTupleAsync().AsTask();
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
            Assert.Equal((i, true), await pair.WaitAsync(Timeout));

            var raw = ch.ReceiveAsync().AsTask();
            await ch.SendAsync(i).AsTask().WaitAsync(Timeout);
            Assert.True((await raw.WaitAsync(Timeout)).Ok);
        }
    }

    [Fact]
    public async Task ParkedReceive_ThroughTheLanguageSurface_AllocatesNothingPerOperation()
    {
        // The allocation witness for S2. Measures the surface the compiler
        // actually emits (`ChannelOps.ReceiveValueAsync(Channel<T>, …)`, what
        // `<-ch` lowers to) on a rendezvous channel, so iterations park.
        //
        // Process-wide, not per-thread: continuations publish with
        // RunContinuationsAsynchronously, so the boxes this exists to detect are
        // allocated on POOL threads. GC.GetAllocatedBytesForCurrentThread sees
        // none of them and reports a clean ~0 even with the wrapper restored,
        // which made an earlier version of this test pass against its own
        // mutant.
        //
        // Thresholded, not exact: the drivers are async methods and the runtime
        // rents and returns pooled objects around them. The mutant allocates
        // ~144 B per park, so a few tens of bytes discriminates it. Release-only:
        // a Debug build's state machines are shaped differently.
        Channel<int> ch = new Chan<int>(0);

        // Warm up the JIT, the node cache and the builder pools before measuring.
        await DrainAsync(ch, 2_000);

        const int Operations = 20_000;
        var before = GC.GetTotalAllocatedBytes(precise: true);
        await DrainAsync(ch, Operations);
        var perOperation = (GC.GetTotalAllocatedBytes(precise: true) - before) / (double)Operations;

#if DEBUG
        Assert.True(perOperation >= 0, "Debug builds do not carry a meaningful allocation number.");
#else
        Assert.True(
            perOperation < 32,
            $"expected a node-backed park to allocate ~nothing, measured {perOperation:F1} B/op. "
            + "A number in the tens means the reshaping wrapper in ChannelOps.Awaited.cs is boxing "
            + "its state machine again — check both the Chan<T> dispatch and the pooling builder "
            + "on Unwrap/ToTuple's local functions (issue #3902 S2).");
#endif

        static async Task DrainAsync(Channel<int> ch, int operations)
        {
            var producer = Task.Run(async () =>
            {
                for (var i = 0; i < operations; i++)
                {
                    await ChannelOps.SendAsync(ch, i, default(CancellationToken)).ConfigureAwait(false);
                }
            });

            for (var i = 0; i < operations; i++)
            {
                await ChannelOps.ReceiveValueAsync(ch, default(CancellationToken)).ConfigureAwait(false);
            }

            await producer.WaitAsync(Timeout).ConfigureAwait(false);
        }
    }
}
