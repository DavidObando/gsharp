// <copyright file="Issue3902NodeBackedReceiveShapesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// Issue #3902 (S2): a suspending receive through the language is backed by the
/// waiter node itself in all three result shapes, rather than by an
/// `async` wrapper that reshapes (cref:ReceiveResult{T}) after the
/// fact. The wrapper ran on the default builder, so every park boxed an
/// `AsyncStateMachineBox` — about 144 bytes — and inserted a Task
/// continuation between the node and the caller's state machine.
/// @remarks Discrimination witnesses (ADR-0154). The product mutant for the allocation
/// claim is reverting S2 <em>entirely</em> in `ChannelOps.Awaited.cs` —
/// both the `is Chan<T>` dispatch and the pooling builder on the
/// wrapper — which
/// (cref:ParkedReceive_ThroughTheLanguageSurface_AllocatesNothingPerOperation)
/// catches at 71.8 B/op against a 32 B threshold.
///
/// Measured, so the claim is not overstated: reverting the dispatch <em>alone</em>
/// does NOT fail that test. The allocation is removed by the pooling builder,
/// and what the dispatch additionally removes is the Task continuation between
/// the node and the caller's state machine — a latency effect this test cannot
/// see. That half is evidenced by the concurrency benchmark, not here.
///
/// A second mutant — dropping the pooling in `OpReceiveNode.TakeResult`,
/// or letting two of the three shapes each return the node — is caught by
/// (cref:ParkedReceives_AcrossShapes_KeepReusingOneNode). A node
/// returned twice is the failure this factoring exists to prevent.
open class Issue3902NodeBackedReceiveShapesTests {
    @Fact
    async func ParkedReceiveValue_DeliversTheValue() {
        let ch = Chan[int32](0)
        let receive = ch.ReceiveValueAsync().AsTask()
        Assert.False(receive.IsCompleted)
        await ch.SendAsync(7).AsTask().WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
        Assert.Equal(7, await receive.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout))
    }

    @Fact
    async func ParkedReceiveTuple_DeliversTheValueAndOk() {
        let ch = Chan[int32](0)
        let receive = ch.ReceiveTupleAsync().AsTask()
        await ch.SendAsync(9).AsTask().WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
        let (value, ok) = await receive.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
        Assert.Equal(9, value)
        Assert.True(ok)
    }

    @Fact
    async func ParkedShapes_OnClose_YieldTheDocumentedClosedResults() {
        // D3: the single-value shape yields the zero value, the two-value shape
        // says so explicitly. Both must hold for a receive already PARKED when
        // the close arrives, which is the path the node backs.
        let single = Chan[int32](0)
        let pair = Chan[int32](0)
        let singleReceive = single.ReceiveValueAsync().AsTask()
        let pairReceive = pair.ReceiveTupleAsync().AsTask()
        single.Close()
        pair.Close()
        Assert.Equal(0, await singleReceive.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout))
        let (value, ok) = await pairReceive.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
        Assert.Equal(0, value)
        Assert.False(ok)
    }

    @Fact
    async func ClosedAndDrained_ShapesCompleteSynchronously() {
        let ch = Chan[int32](1)
        ch.Close()
        let single = ch.ReceiveValueAsync()
        let pair = ch.ReceiveTupleAsync()
        Assert.True(single.IsCompletedSuccessfully)
        Assert.True(pair.IsCompletedSuccessfully)
        Assert.Equal(0, await single)
        Assert.Equal((0, false), await pair)
    }

    @Fact
    async func ParkedShapes_Cancelled_ThrowOperationCanceled() {
        using let cts = CancellationTokenSource()
        let ch = Chan[int32](0)
        let single = ch.ReceiveValueAsync(cts.Token).AsTask()
        let pair = ch.ReceiveTupleAsync(cts.Token).AsTask()
        cts.Cancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return single.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
            }
        )
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return pair.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
            }
        )
    }

    @Fact
    async func ParkedReceives_AcrossShapes_KeepReusingOneNode() {
        // The node cache is a single slot, so a node consumed through any shape
        // must come back to it. Interleaving the shapes is the point: if one of
        // them failed to pool, or pooled twice, the reuse count collapses or the
        // channel starts handing the same node to two waiters.
        let ch = Chan[int32](0)
        for var i = 0; i < 200; i++ {
            let single = ch.ReceiveValueAsync().AsTask()
            await ch.SendAsync(i).AsTask().WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
            Assert.Equal(i, await single.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout))
            let pair = ch.ReceiveTupleAsync().AsTask()
            await ch.SendAsync(i).AsTask().WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
            Assert.Equal((i, true), await pair.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout))
            let raw = ch.ReceiveAsync().AsTask()
            await ch.SendAsync(i).AsTask().WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)
            Assert.True((await raw.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout)).Ok)
        }
    }

    @Fact
    async func ParkedReceive_ThroughTheLanguageSurface_AllocatesNothingPerOperation() {
        let DrainAsync = async func (ch Channel[int32], operations int32) {
            let producer = Task.Run(
                async () -> {
                    for var i = 0; i < operations; i++ {
                        await ChannelOps.SendAsync(ch, i, default(CancellationToken)).ConfigureAwait(false)
                    }
                }
            )
            for var i = 0; i < operations; i++ {
                await ChannelOps.ReceiveValueAsync(ch, default(CancellationToken)).ConfigureAwait(false)
            }
            await producer.WaitAsync(Issue3902NodeBackedReceiveShapesTests.Timeout).ConfigureAwait(false)
        }
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
        let ch Channel[int32] = Chan[int32](0)
        // Warm up the JIT, the node cache and the builder pools before measuring.
        await DrainAsync(ch, 2_000)
        const Operations = 20_000
        let before = GC.GetTotalAllocatedBytes(precise: true)
        await DrainAsync(ch, Operations)
        let perOperation = float64((GC.GetTotalAllocatedBytes(precise: true) - before)) / float64(Operations)
        if OptimizedBuild.IsOptimized() {
            Assert.True(
                perOperation < float64(32.0),
                "expected a node-backed park to allocate ~nothing, measured ${perOperation:F1} B/op. " +
                    "A number in the tens means the reshaping wrapper in ChannelOps.Awaited.cs is boxing " +
                    "its state machine again — check both the Chan<T> dispatch and the pooling builder " +
                    "on Unwrap/ToTuple's local functions (issue #3902 S2)."
            )
        } else {
            Assert.True(perOperation >= float64(0.0), "Debug builds do not carry a meaningful allocation number.")
        }
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
