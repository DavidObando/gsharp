// <copyright file="SelectWaiterStressTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D8 stress witnesses for the transactional select protocol, under
/// real contention. Each is bounded by a hard timeout and sized for a 4-vCPU
/// runner; the project's CI shard runs with `--blame-hang`.
/// @remarks Discrimination witnesses (ADR-0154, mutants applied to
/// `src/Sdk/Gsharp.Runtime.Channels/`): splitting claim-and-transfer in
/// `SelectNode{T}.TryCommitReceive` into a claim followed by a re-probe
/// breaks (cref:Select_UnderCompetingConsumers_NeverLosesOrDuplicates)
/// (a lost or duplicated id within 200 000); removing the generation bump
/// from `SelectWaiter.Begin` is killed deterministically by
/// `SelectWaiterTests.TryClaim_StaleGeneration_IsRejected` — the stress
/// form here, (cref:Select_TimerLoser_InFlightCallback_CannotClaimReusedWaiter),
/// is the integration exercise and is <em>not</em> claimed as a reliable
/// killer (the 1 ms timer callback rarely lands in the window); skipping
/// `Deregister` in `Return` breaks
/// (cref:Select_Losers_LeaveNoRegistrations); acquiring gates in arm
/// order instead of `Chan.Id` order breaks
/// (cref:Select_OppositeArmOrder_DoesNotDeadlock); completing the
/// waiter from the cancellation callback without the CAS breaks
/// (cref:Select_CancelRacingSend_NeverLosesValue).
@Trait("Category", "Stress")
open class SelectWaiterStressTests {
    @Fact
    async func Select_UnderCompetingConsumers_NeverLosesOrDuplicates() {
        const Items = 200_000
        let a = Chan[int32](1)
        let b = Chan[int32](1)
        let seen = ConcurrentDictionary[int32, uint8]()
        var duplicates = 0
        let producers = Task.WhenAll(
            Task.Run(
                async () -> {
                    for var i = 0; i < Items; i += 2 {
                        await a.SendAsync(i)
                    }
                    a.Close()
                }
            ),
            Task.Run(
                async () -> {
                    for var i = 1; i < Items; i += 2 {
                        await b.SendAsync(i)
                    }
                    b.Close()
                }
            )
        )
        let Record = func (v int32) {
            if !seen.TryAdd(v, uint8(0)) {
                Interlocked.Increment(&duplicates)
            }
        }
        let thieves = []Task{
            Task.Run(
                async () -> {
                    while !a.IsClosed || a.Length() > 0 {
                        if a.TryReceive(out var v, out var ok) && ok {
                            Record(v)
                        } else {
                            await Task.Yield()
                        }
                    }
                }
            ),
            Task.Run(
                async () -> {
                    while !b.IsClosed || b.Length() > 0 {
                        if b.TryReceive(out var v, out var ok) && ok {
                            Record(v)
                        } else {
                            await Task.Yield()
                        }
                    }
                }
            )
        }
        let selectors = [4]Task
        for var s = 0; s < selectors.Length; s++ {
            selectors[s] = Task.Run(
                async () -> {
                    var armA Chan[int32]? = a
                    var armB Chan[int32]? = b
                    while armA != nil || armB != nil {
                        let w = SelectWaiter.Rent(2, CancellationToken.None)
                        w.AddReceive[int32](armA, 0)
                        w.AddReceive[int32](armB, 1)
                        let arm = await w.WaitAsync()
                        if w.Ok {
                            Record(w.TakeValue[int32]())
                        } else if arm == 0 {
                            armA = nil
                        } else {
                            armB = nil
                        }
                        w.Return()
                    }
                }
            )
        }
        await Task.WhenAll(producers, Task.WhenAll(thieves), Task.WhenAll(selectors)).WaitAsync(
            SelectWaiterStressTests.Timeout
        )
        Assert.Equal(0, duplicates)
        Assert.Equal(Items, seen.Count)
    }

    @Fact
    async func Select_OppositeArmOrder_DoesNotDeadlock() {
        const Rounds = 100_000
        let a = Chan[int32]()
        let b = Chan[int32]()
        let producer = Task.Run(
            async () -> {
                for var i = 0; i < Rounds; i++ {
                    await (
                        if (i & 1) == 0 {
                            a
                        } else {
                            b
                        }
                    ).SendAsync(i)
                }
                a.Close()
                b.Close()
            }
        )
        let Selector = async func (first Chan[int32], second Chan[int32]) {
            var open_ = 2
            var x Chan[int32]? = first
            var y Chan[int32]? = second
            while open_ > 0 {
                let w = SelectWaiter.Rent(2, CancellationToken.None)
                w.AddReceive[int32](x, 0)
                w.AddReceive[int32](y, 1)
                let arm = await w.WaitAsync()
                if !w.Ok {
                    open_--
                    if arm == 0 {
                        x = nil
                    } else {
                        y = nil
                    }
                }
                w.Return()
            }
        }
        await Task.WhenAll(
            producer,
            Task.Run(
                func () Task? {
                    return Selector(a, b)
                }
            ),
            Task.Run(
                func () Task? {
                    return Selector(b, a)
                }
            )
        )
            .WaitAsync(SelectWaiterStressTests.Timeout)
    }

    @Fact
    async func Select_Losers_LeaveNoRegistrations() {
        let a = Chan[int32]()
        let b = Chan[int32]()
        for var i = 0; i < 10_000; i++ {
            let w = SelectWaiter.Rent(2, CancellationToken.None)
            w.AddReceive[int32](a, 0)
            w.AddReceive[int32](b, 1)
            let wait = w.WaitAsync().AsTask()
            Assert.True(a.TrySend(i))
            Assert.Equal(0, await wait.WaitAsync(SelectWaiterStressTests.Timeout))
            w.Return()
        }
        Assert.Equal(0, a.RegisteredWaiterCount)
        Assert.Equal(0, b.RegisteredWaiterCount)
    }

    @Fact
    async func Select_CancelRacingSend_NeverLosesValue() {
        const Iterations = 10_000
        var delivered = 0
        var cancelled = 0
        let never = Chan[int32]()
        for var i = 0; i < Iterations; i++ {
            let ch = Chan[int32](1)
            using let cts = CancellationTokenSource()
            let w = SelectWaiter.Rent(2, cts.Token)
            w.AddReceive[int32](ch, 0)
            w.AddReceive[int32](never, 1)
            let wait = w.WaitAsync().AsTask()
            using let barrier = Barrier(2)
            let sender = Task.Run(
                () -> {
                    barrier.SignalAndWait()
                    ch.TrySend(i)
                }
            )
            let canceller = Task.Run(
                () -> {
                    barrier.SignalAndWait()
                    cts.Cancel()
                }
            )
            await Task.WhenAll(sender, canceller).WaitAsync(SelectWaiterStressTests.Timeout)
            try {
                Assert.Equal(0, await wait.WaitAsync(SelectWaiterStressTests.Timeout))
                Assert.True(w.Ok)
                Assert.Equal(i, w.TakeValue[int32]())
                Assert.Equal(0, ch.Length())
                delivered++
            } catch (OperationCanceledException) {
                Assert.True(ch.TryReceive(out var v, out var ok) && ok)
                Assert.Equal(i, v)
                cancelled++
            }
            w.Return()
        }
        Assert.Equal(Iterations, delivered + cancelled)
        Assert.True(delivered > 0, "cancellation always won; the race was not exercised")
        Assert.True(cancelled > 0, "the send always won; the race was not exercised")
    }

    @Fact
    async func Select_TimerLoser_InFlightCallback_CannotClaimReusedWaiter() {
        // A timer arm that loses leaves a Timer callback that may still fire
        // against the same (pooled, reused) waiter. The generation stamp must
        // make that claim fail, or a later select would observe a phantom
        // timer win.
        let other = Chan[int32](1)
        for var i = 0; i < 5_000; i++ {
            let ch = Chan[int32](1)
            using let after = Timers.After(TimeSpan.FromMilliseconds(1))
            let w = SelectWaiter.Rent(2, CancellationToken.None)
            w.AddReceive[int32](ch, 0)
            w.AddReceive[DateTime](after, 1)
            let wait = w.WaitAsync().AsTask()
            ch.TrySend(i)
            let arm = await wait.WaitAsync(SelectWaiterStressTests.Timeout)
            w.Return()
            if arm != 0 {
                continue
            }
            // Immediately reuse the pooled waiter on a ready channel; the
            // timer's callback for the previous select may fire right now.
            other.TrySend(-i)
            let w2 = SelectWaiter.Rent(1, CancellationToken.None)
            w2.AddReceive[int32](other, 0)
            Assert.Equal(0, await w2.WaitAsync().AsTask().WaitAsync(SelectWaiterStressTests.Timeout))
            Assert.True(w2.Ok)
            Assert.Equal(-i, w2.TakeValue[int32]())
            w2.Return()
        }
    }

    @Fact
    async func Select_SendArm_OnRendezvous_ReceiverSeesValueOnlyIfArmWon() {
        let ch = Chan[int32]()
        let alt = Chan[int32]()
        var mismatches = 0
        for var i = 0; i < 5_000; i++ {
            let w = SelectWaiter.Rent(2, CancellationToken.None)
            w.AddSend[int32](ch, i, 0)
            w.AddReceive[int32](alt, 1)
            let wait = w.WaitAsync().AsTask()
            // Race a receiver against an alternative win.
            let receiver = Task.Run(
                func () int32? {
                    return if ch.TryReceive(out var v, out var ok) && ok {
                        v
                    } else {
                        default(int32?)
                    }
                }
            )
            alt.TrySend(0)
            let arm = await wait.WaitAsync(SelectWaiterStressTests.Timeout)
            let got = await receiver.WaitAsync(SelectWaiterStressTests.Timeout)
            w.Return()
            if arm == 0 && got != i {
                // The send arm won, so the receiver must be the one who took it
                // (or a later receiver will — check the channel is empty).
                if ch.Length() != 0 {
                    mismatches++
                }
            }
            if arm == 1 && got != nil {
                mismatches++
            }
        }
        Assert.Equal(0, mismatches)
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(60)
    }
}
