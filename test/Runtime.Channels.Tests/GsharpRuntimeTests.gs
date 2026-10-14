// <copyright file="GsharpRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D6/D7, the host-observable surface: the shielded grace budget that
/// bounds a `defer` body during a cancellation unwind, the stall report a
/// scope raises when its join outlives its budget, and the counters a host
/// samples. Budgets are settable so a host (and these tests) need not wait out
/// the five-second default.
/// @remarks Discrimination witnesses (ADR-0154): a mutant whose shielded context has no
/// deadline (an unbounded shield for every `defer`) breaks
/// (cref:ShieldedWithGrace_CancelsAfterTheBudget_AndReportsIt) — the
/// cleanup runs forever and the test times out on its own bounded wait; a
/// mutant that abandons the join when the stall timeout fires breaks
/// (cref:ScopeStall_IsReported_AndTheJoinStillWaits), which asserts the
/// late goroutine's write is observed after the report.
@Collection("runtime-budgets")
open class GsharpRuntimeTests {
    @Fact
    func ShieldedWithGrace_IgnoresOuterCancellation_UntilTheBudgetExpires() {
        let outer = Context.None.WithCancel()
        let shielded = outer.Shielded(TimeSpan.FromSeconds(30))
        outer.TryCancel()
        Assert.True(outer.IsCancelled)
        Assert.True(shielded.IsShielded)
        Assert.False(shielded.IsCancelled)
        Assert.Same(outer, shielded.Parent)
    }

    @Fact
    async func ShieldedWithGrace_CancelsAfterTheBudget_AndReportsIt() {
        let reported = TaskCompletionSource[TimeSpan](TaskCreationOptions.RunContinuationsAsynchronously)
        let OnExpired = func (sender object?, e DeferGraceExpiredEventArgs) {
            reported.TrySetResult(e.Budget)
        }
        let before = GsharpRuntime.DeferGraceExpirations
        GsharpRuntime.DeferGraceExpired += OnExpired
        try {
            let budget = TimeSpan.FromMilliseconds(50)
            let cancellable = Context.None.WithCancel()
            let shielded = cancellable.Shielded(budget)
            Assert.False(shielded.IsCancelled)
            let observed = await reported.Task.WaitAsync(TimeSpan.FromSeconds(10))
            Assert.Equal(budget, observed)
            Assert.True(shielded.IsCancelled)
            Assert.True(GsharpRuntime.DeferGraceExpirations > before)
        } finally {
            GsharpRuntime.DeferGraceExpired -= OnExpired
        }
    }

    @Fact
    func ShieldedWithInfiniteGrace_IsAnUnboundedShield() {
        let shielded = Context.None.WithCancel().Shielded(Timeout.InfiniteTimeSpan)
        Assert.True(shielded.IsShielded)
        Assert.False(shielded.IsCancelled)
        Assert.Equal(CancellationToken.None, shielded.Token)
    }

    @Fact
    func ShieldingNone_IsNone_SoCleanupOutsideAScopeCostsNothing() {
        // A `defer` outside any scope is the common case; there is nothing to
        // be shielded from, so no context and no grace timer are allocated.
        Assert.Same(Context.None, Context.None.Shielded())
        Assert.Same(Context.None, Context.None.Shielded(TimeSpan.FromSeconds(5)))
        Assert.Same(Context.None, Context.None.ShieldedForCleanup())
    }

    @Fact
    async func ScopeStall_IsReported_AndTheJoinStillWaits() {
        let stalls = TaskCompletionSource[ScopeStalledEventArgs](TaskCreationOptions.RunContinuationsAsynchronously)
        let OnStalled = func (sender object?, e ScopeStalledEventArgs) {
            stalls.TrySetResult(e)
        }
        let previousTimeout = GsharpRuntime.ScopeStallTimeout
        let before = GsharpRuntime.ScopeStalls
        GsharpRuntime.ScopeStalled += OnStalled
        GsharpRuntime.ScopeStallTimeout = TimeSpan.FromMilliseconds(50)
        try {
            let frame = ScopeFrame.Enter(nil)
            frame.Register()
            var lateGoroutineRan = false
            let exit = Task.Run(
                async () -> {
                    await frame.ExitAsync()
                }
            )
            let reported = await stalls.Task.WaitAsync(TimeSpan.FromSeconds(10))
            Assert.True(reported.Waited >= TimeSpan.FromMilliseconds(50))
            Assert.Equal(1, reported.PendingGoroutines)
            Assert.False(exit.IsCompleted)
            Assert.True(GsharpRuntime.ScopeStalls > before)
            lateGoroutineRan = true
            frame.Complete()
            await exit.WaitAsync(TimeSpan.FromSeconds(10))
            Assert.True(lateGoroutineRan)
        } finally {
            GsharpRuntime.ScopeStallTimeout = previousTimeout
            GsharpRuntime.ScopeStalled -= OnStalled
        }
    }

    @Fact
    func LiveGoroutines_IsTheGoroutineRuntimesCounter() {
        Assert.Equal(GoroutineRuntime.LiveGoroutines, GsharpRuntime.LiveGoroutines)
    }
}
