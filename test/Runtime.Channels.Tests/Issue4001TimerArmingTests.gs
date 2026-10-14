// <copyright file="Issue4001TimerArmingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Diagnostics
import System.Threading
import Xunit

/// Issue #4001: a timer selectable must be armed only once its own fields are
/// assigned. `new Timer(cb, state, due, period)` arms before it returns, so
/// for a short `due` the callback can run on a thread-pool thread while the
/// constructor is still executing — and `AfterTimer.OnFire` ends in
/// `timer.Dispose()`, on a field that is not yet assigned.
/// @remarks The failure mode is a (cref:NullReferenceException) on a thread-pool
/// thread with nothing to catch it, so it kills the process rather than failing
/// an assertion: on the defective code this file does not report a failed test,
/// it aborts the whole test run ("Test host process crashed"). That is the only
/// shape a regression here can take, and it is exactly the CI symptom the issue
/// reports.
///
/// Discrimination witness (ADR-0154). Reverting
/// `src/Sdk/Gsharp.Runtime.Channels/Timers.cs` to the single-expression
/// `timer = new Timer(…, due, Timeout.InfiniteTimeSpan)` form kills
/// (cref:After_ZeroDelay_ConstructedConcurrently_ArmsOnlyAfterTheFieldIsAssigned)
/// — measured on this machine at a median of ~35 000 constructions across four
/// threads (five for five runs, range 28 239–39 513, all within 20 ms), against
/// the 400 000 the test drives.
///
/// (cref:Tick_SubTickPeriod_ConstructedConcurrently_DoesNotFault) is
/// <em>not</em> claimed as a killer of that mutant: `TickTimer.OnTick`
/// never touches its `timer` field, so the identical constructor shape was
/// measured to be harmless there (900 000 constructions across three runs, no
/// fault). It pins that fact so a future `timer.…` in `OnTick` cannot
/// quietly reintroduce the class.
open class Issue4001TimerArmingTests {
    @Fact
    func After_ZeroDelay_ConstructedConcurrently_ArmsOnlyAfterTheFieldIsAssigned() {
        Race(() -> Timers.After(TimeSpan.Zero).Dispose())
        // Survival alone is vacuous: a constructor that never arms the timer
        // would also survive. Hold a sample and require every one of them to
        // fire.
        let sample = [ArmedSample]AfterTimer
        try {
            for var i = 0; i < sample.Length; i++ {
                sample[i] = Timers.After(TimeSpan.Zero)
            }
            let deadline = Stopwatch.StartNew()
            var fired = 0
            while fired < sample.Length && deadline.Elapsed < TimeSpan.FromSeconds(10) {
                fired = 0
                for timer in sample {
                    if timer.HasFired {
                        fired++
                    }
                }
                if fired < sample.Length {
                    Thread.Sleep(5)
                }
            }
            Assert.Equal(sample.Length, fired)
        } finally {
            for timer in sample {
                timer?.Dispose()
            }
        }
    }

    @Fact
    func Tick_SubTickPeriod_ConstructedConcurrently_DoesNotFault() {
        // The shortest period the constructor accepts. Issue #4008 now quantizes
        // it up to the 1 ms `System.Threading.Timer` can actually deliver — so
        // the first tick is no longer due *immediately*, and this case races the
        // constructor less tightly than it did. It is kept as the pin it always
        // was rather than as a race: the mutant it does NOT kill is documented
        // in this class's remarks, and `Issue4008TickResolutionTests` now covers
        // what the period itself must do.
        Race(() -> Timers.Tick(TimeSpan.FromTicks(1)).Dispose())
    }

    shared {
        /// Threads racing the constructor against its own callback.
        private const Threads int32 = 4

        /// Constructions per thread. The race reproduced within ~35 000 total on a
        /// developer machine, so 100 000 per thread is an order of magnitude of
        /// headroom for a slower CI runner while still costing well under a second.
        private const PerThread int32 = 100_000

        /// Timers held to prove the fix still arms them.
        private const ArmedSample int32 = 512

        private func Race(construct() -> void) {
            let start = Barrier(Threads)
            let workers = [Threads]Thread
            for var t = 0; t < workers.Length; t++ {
                workers[t] = Thread(
                    () -> {
                        start.SignalAndWait()
                        for var i = 0; i < PerThread; i++ {
                            construct()
                        }
                    }
                ){IsBackground = true}
                workers[t].Start()
            }
            for worker in workers {
                Assert.True(worker.Join(TimeSpan.FromMinutes(2)), "A constructing thread did not finish.")
            }
        }
    }
}
