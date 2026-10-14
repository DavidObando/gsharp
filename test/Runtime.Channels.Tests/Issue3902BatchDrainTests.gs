// <copyright file="Issue3902BatchDrainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Runtime.CompilerServices
import System.Threading.Tasks
import SystemObject = System.Object
import Xunit

/// Issue #3902 (S3): a batch receive copies the ring in contiguous spans rather
/// than element by element, and a chunked read sizes its array to what is
/// actually there.
/// @remarks Discrimination witnesses (ADR-0154).
/// (cref:BatchReceive_OfReferenceElements_LeavesNoLiveReferenceInTheRing)
/// is the one that matters: the element-wise loop cleared each slot as it went,
/// and the bulk copy must keep doing so for reference elements or the ring
/// keeps objects alive after they have been received. The mutant is dropping
/// the `IsReferenceOrContainsReferences` clear in `DrainBufferInto` —
/// invisible to every other test, because the VALUES are still correct.
///
/// (cref:BatchReceive_WrappingTheRing_PreservesFifoOrder) covers the
/// two-segment copy specifically; a single-span implementation passes every
/// non-wrapping test and silently reorders here.
open class Issue3902BatchDrainTests {
    @Fact
    func BatchReceive_WrappingTheRing_PreservesFifoOrder() {
        // Force head past zero so the next fill wraps, then take it all in one
        // batch: the copy has to be two segments in the right order.
        let ch = Chan[int32](8)
        for var i = 0; i < 8; i++ {
            Assert.True(ch.TrySend(i))
        }
        let drain = [5]int32
        Assert.Equal(5, ch.TryReceiveBatch(drain))
        for var i = 8; i < 13; i++ {
            Assert.True(ch.TrySend(i))
        }
        let wrapped = [8]int32
        Assert.Equal(8, ch.TryReceiveBatch(wrapped))
        Assert.Equal([]int32{5, 6, 7, 8, 9, 10, 11, 12}, wrapped)
    }

    @Fact
    func BatchReceive_TakingLessThanIsBuffered_LeavesTheRestInOrder() {
        let ch = Chan[int32](8)
        for var i = 0; i < 8; i++ {
            Assert.True(ch.TrySend(i))
        }
        let first = [3]int32
        Assert.Equal(3, ch.TryReceiveBatch(first))
        Assert.Equal([]int32{0, 1, 2}, first)
        let rest = [8]int32
        Assert.Equal(5, ch.TryReceiveBatch(rest))
        Assert.Equal([]int32{3, 4, 5, 6, 7}, rest[.. 5])
    }

    @Fact
    func BatchReceive_OfReferenceElements_LeavesNoLiveReferenceInTheRing() {
        let Fill = func (ch Chan[object])[]WeakReference {
            let witnesses = [4]WeakReference
            for var i = 0; i < 4; i++ {
                let element = SystemObject()
                witnesses[i] = WeakReference(element)
                Assert.True(ch.TrySend(element))
            }
            return witnesses
        }
        let Drain = func (ch Chan[object]) {
            let drained = [4]object
            Assert.Equal(4, ch.TryReceiveBatch(drained))
            Array.Clear(drained)
        }
        let ch = Chan[object](4)
        // Fill and drain in frames of their own: an optimized build can keep a
        // local alive to the end of ITS method, which would root the elements
        // here and fail this test for a reason that has nothing to do with the
        // ring.
        let witnesses = Fill(ch)
        Drain(ch)
        GC.Collect()
        GC.WaitForPendingFinalizers()
        GC.Collect()
        for witness in witnesses {
            Assert.False(
                witness.IsAlive,
                "a received element is still reachable — the ring slot was not cleared, so the " +
                    "channel is keeping delivered objects alive (issue #3902 S3)."
            )
        }
    }

    @Fact
    async func BatchReceive_DrainingWhileSendersAreParked_TakesFromBoth() {
        // The bulk drain breaks out of its loop when no sender is parked; a
        // buffered channel that IS full with senders behind it must still hand
        // over from both sources.
        let ch = Chan[int32](2)
        Assert.True(ch.TrySend(1))
        Assert.True(ch.TrySend(2))
        let parked = ch.SendAsync(3).AsTask()
        let second = ch.SendAsync(4).AsTask()
        let drain = [4]int32
        var taken = 0
        while taken < 4 {
            taken += ch.TryReceiveBatch(drain.AsSpan(taken))
            if taken < 4 {
                await Task.Yield()
            }
        }
        await parked.WaitAsync(TimeSpan.FromSeconds(10))
        await second.WaitAsync(TimeSpan.FromSeconds(10))
        Assert.Equal([]int32{1, 2, 3, 4}, drain)
    }

    @Fact
    func ChunkedRead_OnAnEmptyChannel_AllocatesNothing() {
        let ch = Chan[int32](1024)
        let reader = Chunks.Of(ch, 1024)
        // Warm the paths before measuring.
        for var i = 0; i < 100; i++ {
            reader.TryRead(out _)
        }
        const Probes = 5_000
        let before = GC.GetTotalAllocatedBytes(precise: true)
        for var i = 0; i < Probes; i++ {
            reader.TryRead(out _)
        }
        let perProbe = float64((GC.GetTotalAllocatedBytes(precise: true) - before)) / float64(Probes)
        if OptimizedBuild.IsOptimized() {
            Assert.True(
                perProbe < float64(16.0),
                "expected an empty chunked probe to allocate nothing, measured ${perProbe:F1} B/probe. " +
                    "About 4096 means the chunk array is allocated before the count is known " +
                    "(issue #3902 S3)."
            )
        } else {
            Assert.True(perProbe >= float64(0.0), "Debug builds do not carry a meaningful allocation number.")
        }
    }

    @Fact
    func ChunkedRead_TakesEverythingBuffered() {
        let ch = Chan[int32](64)
        for var i = 0; i < 40; i++ {
            Assert.True(ch.TrySend(i))
        }
        let reader = Chunks.Of(ch, 1024)
        Assert.True(reader.TryRead(out var chunk))
        Assert.Equal(40, chunk.Length)
        Assert.Equal(0, chunk.Span[0])
        Assert.Equal(39, chunk.Span[39])
    }
}
