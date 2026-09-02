// <copyright file="TimerSelectableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>ADR-0174 D9 timer selectables: <c>after</c> fires once, <c>tick</c> repeats with at most one pending tick and stops on dispose.</summary>
public class TimerSelectableTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task After_WinsAgainstNeverReadyChannel_ExactlyOnce()
    {
        var never = new Chan<int>();
        using var after = Timers.After(TimeSpan.FromMilliseconds(30));
        var w = SelectWaiter.Rent(2, default);
        w.AddReceive<int>(never, 0);
        w.AddReceive<DateTime>(after, 1);
        Assert.Equal(1, await w.WaitAsync().AsTask().WaitAsync(Timeout));
        Assert.True(w.Ok);
        Assert.NotEqual(default, w.TakeValue<DateTime>());
        w.Return();
        Assert.Equal(0, never.RegisteredWaiterCount);

        // Drained: never fires again.
        Assert.False(after.TryReceive(out _, out _));
        var w2 = SelectWaiter.Rent(2, default);
        w2.AddReceive<int>(never, 0);
        w2.AddReceive<DateTime>(after, 1);
        var second = w2.WaitAsync().AsTask();
        await Task.Delay(100);
        Assert.False(second.IsCompleted);
        never.TrySend(1);
        Assert.Equal(0, await second.WaitAsync(Timeout));
        w2.Return();
    }

    [Fact]
    public async Task After_AlreadyFired_IsReadyOnProbe()
    {
        using var after = Timers.After(TimeSpan.FromMilliseconds(10));
        await Task.Delay(100);
        Assert.True(after.HasFired);
        Assert.True(after.TryReceive(out var at, out var ok));
        Assert.True(ok);
        Assert.NotEqual(default, at);
        Assert.False(after.TryReceive(out _, out _));
    }

    [Fact]
    public async Task Tick_Repeats_AndDisposeStops()
    {
        var never = new Chan<int>();
        using var tick = Timers.Tick(TimeSpan.FromMilliseconds(20));
        for (var i = 0; i < 3; i++)
        {
            var w = SelectWaiter.Rent(2, default);
            w.AddReceive<int>(never, 0);
            w.AddReceive<DateTime>(tick, 1);
            Assert.Equal(1, await w.WaitAsync().AsTask().WaitAsync(Timeout));
            w.Return();
        }

        tick.Dispose();
        await Task.Delay(60);
        tick.TryReceive(out _, out _); // drain any tick that landed before dispose
        await Task.Delay(60);
        Assert.False(tick.TryReceive(out _, out _));
    }

    [Fact]
    public async Task Tick_HoldsAtMostOnePendingTick()
    {
        using var tick = Timers.Tick(TimeSpan.FromMilliseconds(10));
        await Task.Delay(150);
        Assert.True(tick.TryReceive(out _, out var ok));
        Assert.True(ok);

        // Only one was pending, however many periods elapsed.
        Assert.False(tick.TryReceive(out _, out _));
    }

    [Fact]
    public void Tick_RejectsNonPositivePeriod()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Timers.Tick(TimeSpan.Zero));
    }
}
