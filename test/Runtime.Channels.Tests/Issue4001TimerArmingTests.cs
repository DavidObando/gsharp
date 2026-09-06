// <copyright file="Issue4001TimerArmingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Threading;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Issue #4001: a timer selectable must be armed only once its own fields are
/// assigned. <c>new Timer(cb, state, due, period)</c> arms before it returns, so
/// for a short <c>due</c> the callback can run on a thread-pool thread while the
/// constructor is still executing — and <c>AfterTimer.OnFire</c> ends in
/// <c>timer.Dispose()</c>, on a field that is not yet assigned.
/// </summary>
/// <remarks>
/// The failure mode is a <see cref="NullReferenceException"/> on a thread-pool
/// thread with nothing to catch it, so it kills the process rather than failing
/// an assertion: on the defective code this file does not report a failed test,
/// it aborts the whole test run ("Test host process crashed"). That is the only
/// shape a regression here can take, and it is exactly the CI symptom the issue
/// reports.
/// <para>
/// Discrimination witness (ADR-0154). Reverting
/// <c>src/Sdk/Gsharp.Runtime.Channels/Timers.cs</c> to the single-expression
/// <c>timer = new Timer(…, due, Timeout.InfiniteTimeSpan)</c> form kills
/// <see cref="After_ZeroDelay_ConstructedConcurrently_ArmsOnlyAfterTheFieldIsAssigned"/>
/// — measured on this machine at a median of ~35 000 constructions across four
/// threads (five for five runs, range 28 239–39 513, all within 20 ms), against
/// the 400 000 the test drives.
/// </para>
/// <para>
/// <see cref="Tick_SubTickPeriod_ConstructedConcurrently_DoesNotFault"/> is
/// <em>not</em> claimed as a killer of that mutant: <c>TickTimer.OnTick</c>
/// never touches its <c>timer</c> field, so the identical constructor shape was
/// measured to be harmless there (900 000 constructions across three runs, no
/// fault). It pins that fact so a future <c>timer.…</c> in <c>OnTick</c> cannot
/// quietly reintroduce the class.
/// </para>
/// </remarks>
public class Issue4001TimerArmingTests
{
    /// <summary>Threads racing the constructor against its own callback.</summary>
    private const int Threads = 4;

    /// <summary>
    /// Constructions per thread. The race reproduced within ~35 000 total on a
    /// developer machine, so 100 000 per thread is an order of magnitude of
    /// headroom for a slower CI runner while still costing well under a second.
    /// </summary>
    private const int PerThread = 100_000;

    /// <summary>Timers held to prove the fix still arms them.</summary>
    private const int ArmedSample = 512;

    [Fact]
    public void After_ZeroDelay_ConstructedConcurrently_ArmsOnlyAfterTheFieldIsAssigned()
    {
        Race(() => Timers.After(TimeSpan.Zero).Dispose());

        // Survival alone is vacuous: a constructor that never arms the timer
        // would also survive. Hold a sample and require every one of them to
        // fire.
        var sample = new AfterTimer[ArmedSample];
        try
        {
            for (var i = 0; i < sample.Length; i++)
            {
                sample[i] = Timers.After(TimeSpan.Zero);
            }

            var deadline = Stopwatch.StartNew();
            var fired = 0;
            while (fired < sample.Length && deadline.Elapsed < TimeSpan.FromSeconds(10))
            {
                fired = 0;
                foreach (var timer in sample)
                {
                    if (timer.HasFired)
                    {
                        fired++;
                    }
                }

                if (fired < sample.Length)
                {
                    Thread.Sleep(5);
                }
            }

            Assert.Equal(sample.Length, fired);
        }
        finally
        {
            foreach (var timer in sample)
            {
                timer?.Dispose();
            }
        }
    }

    [Fact]
    public void Tick_SubTickPeriod_ConstructedConcurrently_DoesNotFault()
    {
        // The shortest period the constructor accepts. Issue #4008 now quantizes
        // it up to the 1 ms `System.Threading.Timer` can actually deliver — so
        // the first tick is no longer due *immediately*, and this case races the
        // constructor less tightly than it did. It is kept as the pin it always
        // was rather than as a race: the mutant it does NOT kill is documented
        // in this class's remarks, and `Issue4008TickResolutionTests` now covers
        // what the period itself must do.
        Race(() => Timers.Tick(TimeSpan.FromTicks(1)).Dispose());
    }

    private static void Race(Action construct)
    {
        var start = new Barrier(Threads);
        var workers = new Thread[Threads];
        for (var t = 0; t < workers.Length; t++)
        {
            workers[t] = new Thread(() =>
            {
                start.SignalAndWait();
                for (var i = 0; i < PerThread; i++)
                {
                    construct();
                }
            })
            {
                IsBackground = true,
            };
            workers[t].Start();
        }

        foreach (var worker in workers)
        {
            Assert.True(worker.Join(TimeSpan.FromMinutes(2)), "A constructing thread did not finish.");
        }
    }
}
