// <copyright file="GsharpRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// ADR-0174 D6/D7, the host-observable surface: the shielded grace budget that
/// bounds a <c>defer</c> body during a cancellation unwind, the stall report a
/// scope raises when its join outlives its budget, and the counters a host
/// samples. Budgets are settable so a host (and these tests) need not wait out
/// the five-second default.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154): a mutant whose shielded context has no
/// deadline (an unbounded shield for every <c>defer</c>) breaks
/// <see cref="ShieldedWithGrace_CancelsAfterTheBudget_AndReportsIt"/> — the
/// cleanup runs forever and the test times out on its own bounded wait; a
/// mutant that abandons the join when the stall timeout fires breaks
/// <see cref="ScopeStall_IsReported_AndTheJoinStillWaits"/>, which asserts the
/// late goroutine's write is observed after the report.
/// </remarks>
[Collection("runtime-budgets")]
public class GsharpRuntimeTests
{
    [Fact]
    public void ShieldedWithGrace_IgnoresOuterCancellation_UntilTheBudgetExpires()
    {
        var outer = Context.None.WithCancel();
        var shielded = outer.Shielded(TimeSpan.FromSeconds(30));

        outer.TryCancel();

        Assert.True(outer.IsCancelled);
        Assert.True(shielded.IsShielded);
        Assert.False(shielded.IsCancelled);
        Assert.Same(outer, shielded.Parent);
    }

    [Fact]
    public async Task ShieldedWithGrace_CancelsAfterTheBudget_AndReportsIt()
    {
        var reported = new TaskCompletionSource<TimeSpan>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnExpired(object? sender, DeferGraceExpiredEventArgs e) => reported.TrySetResult(e.Budget);

        var before = GsharpRuntime.DeferGraceExpirations;
        GsharpRuntime.DeferGraceExpired += OnExpired;
        try
        {
            var budget = TimeSpan.FromMilliseconds(50);
            var cancellable = Context.None.WithCancel();
            var shielded = cancellable.Shielded(budget);
            Assert.False(shielded.IsCancelled);

            var observed = await reported.Task.WaitAsync(TimeSpan.FromSeconds(10));

            Assert.Equal(budget, observed);
            Assert.True(shielded.IsCancelled);
            Assert.True(GsharpRuntime.DeferGraceExpirations > before);
        }
        finally
        {
            GsharpRuntime.DeferGraceExpired -= OnExpired;
        }
    }

    [Fact]
    public void ShieldedWithInfiniteGrace_IsAnUnboundedShield()
    {
        var shielded = Context.None.WithCancel().Shielded(Timeout.InfiniteTimeSpan);

        Assert.True(shielded.IsShielded);
        Assert.False(shielded.IsCancelled);
        Assert.Equal(CancellationToken.None, shielded.Token);
    }

    [Fact]
    public void ShieldingNone_IsNone_SoCleanupOutsideAScopeCostsNothing()
    {
        // A `defer` outside any scope is the common case; there is nothing to
        // be shielded from, so no context and no grace timer are allocated.
        Assert.Same(Context.None, Context.None.Shielded());
        Assert.Same(Context.None, Context.None.Shielded(TimeSpan.FromSeconds(5)));
        Assert.Same(Context.None, Context.None.ShieldedForCleanup());
    }

    [Fact]
    public async Task ScopeStall_IsReported_AndTheJoinStillWaits()
    {
        var stalls = new TaskCompletionSource<ScopeStalledEventArgs>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnStalled(object? sender, ScopeStalledEventArgs e) => stalls.TrySetResult(e);

        var previousTimeout = GsharpRuntime.ScopeStallTimeout;
        var before = GsharpRuntime.ScopeStalls;
        GsharpRuntime.ScopeStalled += OnStalled;
        GsharpRuntime.ScopeStallTimeout = TimeSpan.FromMilliseconds(50);
        try
        {
            var frame = ScopeFrame.Enter(null);
            frame.Register();
            var lateGoroutineRan = false;

            var exit = Task.Run(async () => await frame.ExitAsync());
            var reported = await stalls.Task.WaitAsync(TimeSpan.FromSeconds(10));

            Assert.True(reported.Waited >= TimeSpan.FromMilliseconds(50));
            Assert.Equal(1, reported.PendingGoroutines);
            Assert.False(exit.IsCompleted);
            Assert.True(GsharpRuntime.ScopeStalls > before);

            lateGoroutineRan = true;
            frame.Complete();
            await exit.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(lateGoroutineRan);
        }
        finally
        {
            GsharpRuntime.ScopeStallTimeout = previousTimeout;
            GsharpRuntime.ScopeStalled -= OnStalled;
        }
    }

    [Fact]
    public void LiveGoroutines_IsTheGoroutineRuntimesCounter()
    {
        Assert.Equal(GoroutineRuntime.LiveGoroutines, GsharpRuntime.LiveGoroutines);
    }
}
