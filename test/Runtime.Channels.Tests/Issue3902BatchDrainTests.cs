// <copyright file="Issue3902BatchDrainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Issue #3902 (S3): a batch receive copies the ring in contiguous spans rather
/// than element by element, and a chunked read sizes its array to what is
/// actually there.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154).
/// <see cref="BatchReceive_OfReferenceElements_LeavesNoLiveReferenceInTheRing"/>
/// is the one that matters: the element-wise loop cleared each slot as it went,
/// and the bulk copy must keep doing so for reference elements or the ring
/// keeps objects alive after they have been received. The mutant is dropping
/// the <c>IsReferenceOrContainsReferences</c> clear in <c>DrainBufferInto</c> —
/// invisible to every other test, because the VALUES are still correct.
/// <para>
/// <see cref="BatchReceive_WrappingTheRing_PreservesFifoOrder"/> covers the
/// two-segment copy specifically; a single-span implementation passes every
/// non-wrapping test and silently reorders here.
/// </para>
/// </remarks>
public class Issue3902BatchDrainTests
{
    [Fact]
    public void BatchReceive_WrappingTheRing_PreservesFifoOrder()
    {
        // Force head past zero so the next fill wraps, then take it all in one
        // batch: the copy has to be two segments in the right order.
        var ch = new Chan<int>(8);
        for (var i = 0; i < 8; i++)
        {
            Assert.True(ch.TrySend(i));
        }

        var drain = new int[5];
        Assert.Equal(5, ch.TryReceiveBatch(drain));

        for (var i = 8; i < 13; i++)
        {
            Assert.True(ch.TrySend(i));
        }

        var wrapped = new int[8];
        Assert.Equal(8, ch.TryReceiveBatch(wrapped));
        Assert.Equal(new[] { 5, 6, 7, 8, 9, 10, 11, 12 }, wrapped);
    }

    [Fact]
    public void BatchReceive_TakingLessThanIsBuffered_LeavesTheRestInOrder()
    {
        var ch = new Chan<int>(8);
        for (var i = 0; i < 8; i++)
        {
            Assert.True(ch.TrySend(i));
        }

        var first = new int[3];
        Assert.Equal(3, ch.TryReceiveBatch(first));
        Assert.Equal(new[] { 0, 1, 2 }, first);

        var rest = new int[8];
        Assert.Equal(5, ch.TryReceiveBatch(rest));
        Assert.Equal(new[] { 3, 4, 5, 6, 7 }, rest[..5]);
    }

    [Fact]
    public void BatchReceive_OfReferenceElements_LeavesNoLiveReferenceInTheRing()
    {
        var ch = new Chan<object>(4);

        // Fill and drain in frames of their own: an optimized build can keep a
        // local alive to the end of ITS method, which would root the elements
        // here and fail this test for a reason that has nothing to do with the
        // ring.
        var witnesses = Fill(ch);
        Drain(ch);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        foreach (var witness in witnesses)
        {
            Assert.False(
                witness.IsAlive,
                "a received element is still reachable — the ring slot was not cleared, so the "
                + "channel is keeping delivered objects alive (issue #3902 S3).");
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static WeakReference[] Fill(Chan<object> ch)
        {
            var witnesses = new WeakReference[4];
            for (var i = 0; i < 4; i++)
            {
                var element = new object();
                witnesses[i] = new WeakReference(element);
                Assert.True(ch.TrySend(element));
            }

            return witnesses;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Drain(Chan<object> ch)
        {
            var drained = new object[4];
            Assert.Equal(4, ch.TryReceiveBatch(drained));
            Array.Clear(drained);
        }
    }

    [Fact]
    public async Task BatchReceive_DrainingWhileSendersAreParked_TakesFromBoth()
    {
        // The bulk drain breaks out of its loop when no sender is parked; a
        // buffered channel that IS full with senders behind it must still hand
        // over from both sources.
        var ch = new Chan<int>(2);
        Assert.True(ch.TrySend(1));
        Assert.True(ch.TrySend(2));

        var parked = ch.SendAsync(3).AsTask();
        var second = ch.SendAsync(4).AsTask();

        var drain = new int[4];
        var taken = 0;
        while (taken < 4)
        {
            taken += ch.TryReceiveBatch(drain.AsSpan(taken));
            if (taken < 4)
            {
                await Task.Yield();
            }
        }

        await parked.WaitAsync(TimeSpan.FromSeconds(10));
        await second.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(new[] { 1, 2, 3, 4 }, drain);
    }

    [Fact]
    public void ChunkedRead_OnAnEmptyChannel_AllocatesNothing()
    {
        var ch = new Chan<int>(1024);
        var reader = Chunks.Of(ch, 1024);

        // Warm the paths before measuring.
        for (var i = 0; i < 100; i++)
        {
            reader.TryRead(out _);
        }

        const int Probes = 5_000;
        var before = GC.GetTotalAllocatedBytes(precise: true);
        for (var i = 0; i < Probes; i++)
        {
            reader.TryRead(out _);
        }

        var perProbe = (GC.GetTotalAllocatedBytes(precise: true) - before) / (double)Probes;
#if DEBUG
        Assert.True(perProbe >= 0, "Debug builds do not carry a meaningful allocation number.");
#else
        Assert.True(
            perProbe < 16,
            $"expected an empty chunked probe to allocate nothing, measured {perProbe:F1} B/probe. "
            + "About 4096 means the chunk array is allocated before the count is known "
            + "(issue #3902 S3).");
#endif
    }

    [Fact]
    public void ChunkedRead_TakesEverythingBuffered()
    {
        var ch = new Chan<int>(64);
        for (var i = 0; i < 40; i++)
        {
            Assert.True(ch.TrySend(i));
        }

        var reader = Chunks.Of(ch, 1024);
        Assert.True(reader.TryRead(out var chunk));
        Assert.Equal(40, chunk.Length);
        Assert.Equal(0, chunk.Span[0]);
        Assert.Equal(39, chunk.Span[39]);
    }
}
