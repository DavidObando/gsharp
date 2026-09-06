// <copyright file="Issue4008TickResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Threading;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Issue #4008: <c>tick(d)</c> with a sub-millisecond <c>d</c> fired exactly
/// once and then went silent forever. <see cref="Timer"/> truncates a
/// <see cref="TimeSpan"/> to whole milliseconds, so <c>0 &lt; d &lt; 1ms</c>
/// was armed with a period of ZERO — and a period of zero DISABLES periodic
/// signalling, per the <see cref="Timer.Change(TimeSpan, TimeSpan)"/> contract.
/// The guard rejected only <c>period &lt;= TimeSpan.Zero</c>, so the author got
/// no error: a repeating API silently degraded to a one-shot.
/// </summary>
/// <remarks>
/// <para><b>The semantics chosen, and why.</b> Both timers now round a strictly
/// positive interval UP to the next whole millisecond
/// (<c>Timers.Quantize</c>) — one rule: <em>an armed interval is never shorter
/// than the one asked for</em>. Rejecting a sub-millisecond period was the
/// alternative, and is rejected in turn because it makes <c>tick</c> PARTIAL on
/// positive inputs, which Go's <c>time.Ticker</c> is not: Go panics only on a
/// NON-positive period and otherwise keeps ticking at whatever resolution the
/// platform gives. Rounding up also fixes a second, quieter truncation the
/// issue's own table shows above the cliff — <c>tick(1.5ms)</c> and
/// <c>tick(1ms)</c> both ticked at 1 ms, so a 1.5 ms request ran 50% FAST.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Measured on this machine
/// against the pre-fix <c>Gsharp.Runtime.Channels.dll</c>, a busy-polled 500 ms
/// window:</para>
/// <code>
/// requested   pre-fix ticks   post-fix ticks
/// 0.1 ms          1               426
/// 0.5 ms          1               422
/// 0.9 ms          1               428
/// 1.0 ms        426               429
/// 1.5 ms        426               249   &lt;- was armed at 1 ms, now at 2 ms
/// 2.0 ms        249               250
/// 2.5 ms        249               166   &lt;- was armed at 2 ms, now at 3 ms
/// 3.0 ms        166               166
/// </code>
/// <para>The sub-millisecond rows never reached 2 ticks at all: asked to count
/// to 20 with a 10 s deadline, the pre-fix build timed out at 10 000 ms for
/// 0.1, 0.5 and 0.9 ms. That is why
/// <see cref="Tick_SubMillisecondPeriod_KeepsTicking"/> uses a floor of 20 with
/// a generous deadline rather than a rate: the broken build cannot reach 2, the
/// fixed build reaches 20 in 24-26 ms (measured), and a slow CI runner only
/// moves the fixed build's time, never its outcome.</para>
/// <para><see cref="Tick_FractionalPeriod_IsNotArmedFasterThanAsked"/> is the
/// upper-bound half, and it is robust for the same structural reason a rate
/// assertion usually is not: a <see cref="Timer"/> can only ever run LATE. A
/// 2 ms armed period physically cannot produce more than 250 firings in 500 ms,
/// so the ceiling of 320 has 28% of headroom against the fixed build and still
/// sits far below the 426 the broken build produced. Those two rows discriminate
/// only where the platform's timer granularity really is ~1 ms, which is the
/// case on the Linux runners the suite runs on; on a host with a 15.6 ms tick
/// they pass vacuously, since even the broken build could not exceed the
/// ceiling. Their non-vacuity floor is set low enough to survive that. The
/// sub-millisecond rows discriminate everywhere, because the broken build
/// produced exactly ONE tick whatever the granularity.</para>
/// <para><b><c>after</c> is quantized too, and that is measurable.</b> A
/// one-shot armed at 0 still fires, so <c>after</c> had no failure mode — but a
/// sub-millisecond delay was truncated to an immediate fire, against Go's "at
/// least <c>d</c>" contract for <c>time.After</c>. Mean latency over 200
/// samples, pre-fix: <c>due=0.1/0.5/0.9ms -> 0.007 ms</c>, against
/// <c>due=1.0/1.5ms -> 1.19 ms</c>. After the fix the sub-millisecond rows join
/// the 1 ms row at 1.18-1.20 ms, and <c>due=1.5ms</c> moves up to 2.26 ms. The
/// MEAN, not the minimum, is the discriminator: the .NET timer queue coalesces,
/// so a single 1 ms timer can still be observed firing in 8 µs (measured),
/// which is why
/// <see cref="After_SubMillisecondDelay_IsNoLongerTruncatedToAnImmediateFire"/>
/// averages a sample instead of asserting on one arm.</para>
/// <para>ADR-0174 D9 is the feature; erratum 46 records the contract change.</para>
/// </remarks>
public class Issue4008TickResolutionTests
{
    /// <summary>
    /// Ticks required before the sub-millisecond rows are called repeating. The
    /// broken build produced exactly one tick and then nothing, ever, so any
    /// floor above 1 discriminates; 20 is chosen so that a fixed build which
    /// somehow armed a one-shot-plus-a-few could not sneak through.
    /// </summary>
    private const int RepeatFloor = 20;

    /// <summary>
    /// Deadline for reaching <see cref="RepeatFloor"/>. The fixed build takes
    /// ~25 ms; 10 s is the same order of headroom
    /// <c>Issue4001TimerArmingTests</c> gives its arming sample.
    /// </summary>
    private static readonly TimeSpan RepeatDeadline = TimeSpan.FromSeconds(10);

    /// <summary>The measurement window for the rate rows.</summary>
    private static readonly TimeSpan RateWindow = TimeSpan.FromMilliseconds(500);

    public static TheoryData<double> SubMillisecondPeriods() => new(0.1, 0.5, 0.9);

    [Theory]
    [MemberData(nameof(SubMillisecondPeriods))]
    public void Tick_SubMillisecondPeriod_KeepsTicking(double milliseconds)
    {
        using var ticker = Timers.Tick(TimeSpan.FromMilliseconds(milliseconds));

        var clock = Stopwatch.StartNew();
        var ticks = 0;
        while (ticks < RepeatFloor && clock.Elapsed < RepeatDeadline)
        {
            if (ticker.TryReceive(out _, out _))
            {
                ticks++;
            }
            else
            {
                Thread.SpinWait(50);
            }
        }

        Assert.True(
            ticks >= RepeatFloor,
            $"tick({milliseconds} ms) produced {ticks} tick(s) in {clock.Elapsed.TotalMilliseconds:F0} ms; "
                + $"a repeating timer must reach {RepeatFloor}. Before the fix this row produced exactly 1 and then went silent.");
    }

    [Fact]
    public void Tick_ShortestPeriodTheConstructorAccepts_KeepsTicking()
    {
        // `TimeSpan.FromTicks(1)` is 100 ns: the smallest positive period the
        // guard admits, and the one `Issue4001TimerArmingTests` constructs.
        using var ticker = Timers.Tick(TimeSpan.FromTicks(1));

        var clock = Stopwatch.StartNew();
        var ticks = 0;
        while (ticks < RepeatFloor && clock.Elapsed < RepeatDeadline)
        {
            if (ticker.TryReceive(out _, out _))
            {
                ticks++;
            }
            else
            {
                Thread.SpinWait(50);
            }
        }

        Assert.True(ticks >= RepeatFloor, $"tick(1 tick = 100 ns) produced {ticks} tick(s) in {clock.Elapsed.TotalMilliseconds:F0} ms.");
    }

    [Theory]
    [InlineData(1.5, 320)]
    [InlineData(2.5, 220)]
    public void Tick_FractionalPeriod_IsNotArmedFasterThanAsked(double milliseconds, int ceiling)
    {
        // A `Timer` only ever runs LATE, so an upper bound on the observed
        // count is a sound assertion about the ARMED period. 1.5 ms rounds up
        // to 2 ms (<= 250 firings in 500 ms) where truncation armed it at 1 ms
        // (measured 426); 2.5 ms rounds up to 3 ms (<= 166) where truncation
        // armed it at 2 ms (measured 249).
        using var ticker = Timers.Tick(TimeSpan.FromMilliseconds(milliseconds));

        var clock = Stopwatch.StartNew();
        var ticks = 0;
        while (clock.Elapsed < RateWindow)
        {
            if (ticker.TryReceive(out _, out _))
            {
                ticks++;
            }
            else
            {
                Thread.SpinWait(50);
            }
        }

        Assert.True(
            ticks <= ceiling,
            $"tick({milliseconds} ms) produced {ticks} tick(s) in {RateWindow.TotalMilliseconds:F0} ms, above the {ceiling} ceiling: "
                + "the armed period is shorter than the one asked for.");

        // Not vacuous: it must still be ticking. The floor is deliberately far
        // below the ~250 this row produces on a 1 ms-granularity host, because
        // a coarse-timer host would deliver only ~32 in the same window.
        Assert.True(ticks >= 5, $"tick({milliseconds} ms) produced only {ticks} tick(s); it must still repeat.");
    }

    [Fact]
    public void Tick_NonPositivePeriod_IsStillRejected()
    {
        // The pre-existing guard is unchanged: quantization is not a licence to
        // accept a period Go itself panics on.
        Assert.Throws<ArgumentOutOfRangeException>(() => Timers.Tick(TimeSpan.Zero));
        Assert.Throws<ArgumentOutOfRangeException>(() => Timers.Tick(TimeSpan.FromMilliseconds(-1)));
    }

    [Fact]
    public void After_SubMillisecondDelay_IsNoLongerTruncatedToAnImmediateFire()
    {
        // Pre-fix means over 200 samples: 0.9 ms -> 0.007 ms, 1.0 ms -> 1.19 ms.
        // Post-fix the two must land together, because 0.9 ms is armed at 1 ms.
        // Asserted as "at least a third of the 1 ms row" rather than an absolute
        // figure so a loaded runner, which inflates BOTH means, cannot fail it.
        var sub = MeanAfterLatency(TimeSpan.FromMilliseconds(0.9), 200);
        var whole = MeanAfterLatency(TimeSpan.FromMilliseconds(1), 200);

        Assert.True(
            sub >= whole / 3,
            $"after(0.9 ms) had a mean latency of {sub.TotalMilliseconds:F3} ms against after(1 ms)'s "
                + $"{whole.TotalMilliseconds:F3} ms; a sub-millisecond delay is still being truncated to an immediate fire.");
    }

    [Fact]
    public void After_Zero_StaysImmediate()
    {
        // `Timers.Quantize` leaves non-positive intervals alone, so `after(0)`
        // keeps the "ready now" behaviour `Issue4001TimerArmingTests` races.
        using var timer = Timers.After(TimeSpan.Zero);
        var clock = Stopwatch.StartNew();
        while (!timer.HasFired && clock.Elapsed < TimeSpan.FromSeconds(10))
        {
            Thread.SpinWait(20);
        }

        Assert.True(timer.HasFired, "after(0) must still fire.");
        Assert.True(
            clock.Elapsed < TimeSpan.FromMilliseconds(500),
            $"after(0) took {clock.Elapsed.TotalMilliseconds:F0} ms; it must stay immediate.");
    }

    [Theory]
    // Non-positive intervals pass through untouched: `after(0)` stays immediate
    // and `Timeout.InfiniteTimeSpan` stays a disarmed timer.
    [InlineData(0L, 0L)]
    [InlineData(-1L * TimeSpan.TicksPerMillisecond, -1L * TimeSpan.TicksPerMillisecond)]
    // Anything already on a whole millisecond is returned unchanged...
    [InlineData(TimeSpan.TicksPerMillisecond, TimeSpan.TicksPerMillisecond)]
    [InlineData(5L * TimeSpan.TicksPerMillisecond, 5L * TimeSpan.TicksPerMillisecond)]
    // ...and anything else rounds UP to the next one, including the smallest
    // positive TimeSpan there is.
    [InlineData(1L, TimeSpan.TicksPerMillisecond)]
    [InlineData(TimeSpan.TicksPerMillisecond - 1, TimeSpan.TicksPerMillisecond)]
    [InlineData(TimeSpan.TicksPerMillisecond + 1, 2L * TimeSpan.TicksPerMillisecond)]
    [InlineData(15L * TimeSpan.TicksPerMillisecond / 10, 2L * TimeSpan.TicksPerMillisecond)]
    [InlineData(25L * TimeSpan.TicksPerMillisecond / 10, 3L * TimeSpan.TicksPerMillisecond)]
    public void Quantize_RoundsAStrictlyPositiveIntervalUpToAWholeMillisecond(long inputTicks, long expectedTicks)
        => Assert.Equal(
            TimeSpan.FromTicks(expectedTicks),
            Timers.Quantize(TimeSpan.FromTicks(inputTicks)));

    private static TimeSpan MeanAfterLatency(TimeSpan due, int samples)
    {
        var total = TimeSpan.Zero;
        for (var i = 0; i < samples; i++)
        {
            var clock = Stopwatch.StartNew();
            using var timer = Timers.After(due);
            while (!timer.HasFired)
            {
                Thread.SpinWait(20);
            }

            total += clock.Elapsed;
        }

        return total / samples;
    }
}
