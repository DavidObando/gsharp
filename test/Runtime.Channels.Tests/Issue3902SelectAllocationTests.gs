// <copyright file="Issue3902SelectAllocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3902 (S4): a `select` over G# channels allocates nothing in
/// steady state. Two costs were measured and both are removed here — an arm
/// descriptor per arm per select, and a box for every value-typed element the
/// winning arm delivered.
/// @remarks Discrimination witnesses (ADR-0154). The mutants are, respectively,
/// restoring `arms.Add(new CoreReceiveArm<T>(…))` in place of the
/// slot reuse, and restoring `waiter.Deposit(value, …)` in place of
/// `DepositFrom` — each caught by
/// (cref:ReadySelect_InSteadyState_AllocatesNothing).
///
/// (cref:ReusedSlot_OfADifferentShape_IsReplacedNotReinterpreted) is the
/// one that matters for correctness rather than cost: the waiter is
/// thread-cached and shared by every select on the thread, so a slot holding a
/// `CoreReceiveArm<int>` must not be handed to a select whose arm is
/// a different element type. The type test in `PlaceReceive` is what
/// prevents it; without it this reads a value at the wrong type.
///
/// Not covered here because it is covered better elsewhere: descriptor reuse is
/// exactly where a generation/ABA defect would hide, and
/// `SelectWaiterStressTests` is the suite that finds those.
open class Issue3902SelectAllocationTests {
    @Fact
    func ReadySelect_InSteadyState_AllocatesNothing() {
        // No xunit assertions inside the measured loop: Assert.Equal allocates,
        // and an earlier version of this test measured 448 B/select of its own
        // making. Correctness of the same path is asserted by the other tests
        // in this class; here the loop only has to exercise it.
        let Drain = func (a Chan[int32], b Chan[int32], selects int32) int64 {
            var observed int64 = 0
            for var i = 0; i < selects; i++ {
                a.TrySend(i)
                b.TrySend(i)
                let w = SelectWaiter.Rent(2, CancellationToken.None)
                w.AddReceive(a, 0)
                w.AddReceive(b, 1)
                let won = w.TryNow()
                observed += int64(w.TakeValue[int32]() + won)
                w.Return()
                // The arm the select did not take keeps its buffered value, so
                // drain it to keep both channels at the same depth.
                let other = if won == 0 {
                    b
                } else {
                    a
                }
                other.TryReceive(out _, out _)
            }
            return observed
        }
        let a = Chan[int32](1)
        let b = Chan[int32](1)
        // Warm the thread-cached waiter, its arm slots and the JIT before
        // measuring; the first select on a thread legitimately allocates.
        let warm = Drain(a, b, 500)
        Assert.True(warm > int64(0), "the warm-up loop should have taken values")
        const Selects = 20_000
        let before = GC.GetTotalAllocatedBytes(precise: true)
        let taken = Drain(a, b, Selects)
        let perSelect = float64((GC.GetTotalAllocatedBytes(precise: true) - before)) / float64(Selects)
        Assert.True(taken > int64(0), "the measured loop should have taken values")
        if OptimizedBuild.IsOptimized() {
            Assert.True(
                perSelect < float64(12.0),
                "expected a ready select to allocate ~nothing, measured ${perSelect:F1} B/select. " +
                    "Roughly 104 B means the arm descriptors are being allocated per select again; " +
                    "a smaller excess means the winning value is boxing through SelectWaiter.Deposit " +
                    "instead of DepositFrom (issue #3902 S4)."
            )
        } else {
            Assert.True(perSelect >= float64(0.0), "Debug builds do not carry a meaningful allocation number.")
        }
    }

    @Fact
    func ReusedSlot_OfADifferentShape_IsReplacedNotReinterpreted() {
        // Same thread, same waiter cache, different element types in slot 0.
        let ints = Chan[int32](1)
        let strings = Chan[string](1)
        ints.TrySend(11)
        let first = SelectWaiter.Rent(1, CancellationToken.None)
        first.AddReceive(ints, 0)
        Assert.Equal(0, first.TryNow())
        Assert.Equal(11, first.TakeValue[int32]())
        first.Return()
        strings.TrySend("eleven")
        let second = SelectWaiter.Rent(1, CancellationToken.None)
        second.AddReceive(strings, 0)
        Assert.Equal(0, second.TryNow())
        Assert.Equal("eleven", second.TakeValue[string]())
        second.Return()
    }

    @Fact
    async func ParkedSelect_DeliversTheValueThroughTheTypedHandoff() {
        // The parked path deposits from SelectNode<T> rather than from the arm
        // descriptor, so it needs its own coverage.
        let a = Chan[int32](0)
        let b = Chan[int32](0)
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive(a, 0)
        w.AddReceive(b, 1)
        let wait = w.WaitAsync().AsTask()
        Assert.False(wait.IsCompleted)
        await b.SendAsync(77).AsTask().WaitAsync(TimeSpan.FromSeconds(10))
        Assert.Equal(1, await wait.WaitAsync(TimeSpan.FromSeconds(10)))
        Assert.True(w.Ok)
        Assert.Equal(77, w.TakeValue[int32]())
        w.Return()
    }

    @Fact
    async func ParkedSelect_OnClose_TakesTheZeroValueWithOkFalse() {
        let a = Chan[int32](0)
        let w = SelectWaiter.Rent(1, CancellationToken.None)
        w.AddReceive(a, 0)
        let wait = w.WaitAsync().AsTask()
        a.Close()
        Assert.Equal(0, await wait.WaitAsync(TimeSpan.FromSeconds(10)))
        Assert.False(w.Ok)
        Assert.Equal(0, w.TakeValue[int32]())
        w.Return()
    }
}
