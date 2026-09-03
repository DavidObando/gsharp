// <copyright file="ConcurrencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// ADR-0174 D9: the G#-authored concurrency helpers, exercised against the
/// compiled extension assembly. A G# caller reaches these by bare name — the
/// namespace is implicitly imported and hoists its statics — so they live on
/// the package's <c>&lt;Program&gt;</c> type and are reached here the way any
/// foreign caller would.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154): a mutant whose <c>merge</c> closes the
/// output before every forwarder has finished breaks
/// <see cref="Merge_DeliversEveryValueFromEveryInput_ThenCloses"/> (values go
/// missing); one that never closes it hangs that test's drain, which is bounded
/// by the test's own timeout; a mutant whose <c>after</c> returns a timer that
/// never fires breaks <see cref="After_FiresOnce"/>.
/// </remarks>
public class ConcurrencyTests
{
    private static readonly Type Helpers = Assembly.Load("Gsharp.Extensions").GetType("Gsharp.Concurrency.<Program>")!;

    [Fact]
    public void Merge_DeliversEveryValueFromEveryInput_ThenCloses()
    {
        var left = new Chan<int>(4);
        var right = new Chan<int>(4);
        for (var i = 1; i <= 3; i++)
        {
            left.TrySend(i);
            right.TrySend(i * 10);
        }

        left.Close();
        right.Close();

        var merged = Merge(left, right);

        var seen = new List<int>();
        var deadline = Stopwatch.StartNew();
        while (seen.Count < 6 && deadline.Elapsed < TimeSpan.FromSeconds(10))
        {
            var (value, ok) = ChannelOps.Receive2(merged, CancellationToken.None);
            if (!ok)
            {
                break;
            }

            seen.Add(value);
        }

        seen.Sort();
        Assert.Equal(new[] { 1, 2, 3, 10, 20, 30 }, seen);

        // Closed once every input closed: the next receive reports no value.
        var (_, stillOpen) = ChannelOps.Receive2(merged, CancellationToken.None);
        Assert.False(stillOpen);
    }

    [Fact]
    public void Merge_OneInputClosing_DoesNotCloseTheOutput()
    {
        var closing = new Chan<int>(1);
        var open = new Chan<int>(1);
        closing.TrySend(7);
        closing.Close();

        var merged = Merge(closing, open);

        var (first, ok) = ChannelOps.Receive2(merged, CancellationToken.None);
        Assert.True(ok);
        Assert.Equal(7, first);

        open.TrySend(9);
        var (second, stillOk) = ChannelOps.Receive2(merged, CancellationToken.None);
        Assert.True(stillOk);
        Assert.Equal(9, second);

        open.Close();
        var (_, drained) = ChannelOps.Receive2(merged, CancellationToken.None);
        Assert.False(drained);
    }

    [Fact]
    public void After_FiresOnce()
    {
        var timer = (AfterTimer)Helpers.GetMethod("after")!.Invoke(null, new object[] { TimeSpan.FromMilliseconds(30) })!;
        Assert.False(timer.HasFired);

        var deadline = Stopwatch.StartNew();
        while (!timer.HasFired && deadline.Elapsed < TimeSpan.FromSeconds(10))
        {
            Thread.Sleep(5);
        }

        Assert.True(timer.HasFired);
        Assert.True(timer.TryReceive(out _, out var ok));
        Assert.True(ok);

        // One shot: the value is consumed exactly once.
        Assert.False(timer.TryReceive(out _, out _));
    }

    [Fact]
    public void Tick_FiresRepeatedly_AndStopsWhenDisposed()
    {
        using var timer = (TickTimer)Helpers.GetMethod("tick")!.Invoke(null, new object[] { TimeSpan.FromMilliseconds(20) })!;

        var fires = 0;
        var deadline = Stopwatch.StartNew();
        while (fires < 2 && deadline.Elapsed < TimeSpan.FromSeconds(10))
        {
            if (timer.TryReceive(out _, out var ok) && ok)
            {
                fires++;
                continue;
            }

            Thread.Sleep(5);
        }

        Assert.True(fires >= 2);

        timer.Dispose();
        timer.TryReceive(out _, out _);
        Thread.Sleep(60);
        Assert.False(timer.TryReceive(out _, out _));
    }

    private static System.Threading.Channels.ChannelReader<int> Merge(params Chan<int>[] inputs)
    {
        var merge = Helpers.GetMethod("merge")!.MakeGenericMethod(typeof(int));
        var packed = Array.CreateInstance(typeof(System.Threading.Channels.Channel<int>), inputs.Length);
        for (var i = 0; i < inputs.Length; i++)
        {
            packed.SetValue(inputs[i], i);
        }

        return (System.Threading.Channels.ChannelReader<int>)merge.Invoke(null, new object[] { packed })!;
    }
}
