// <copyright file="TimerSelectableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0174 D9 timer selectables: `after` fires once, `tick` repeats with at most one pending tick and
/// stops on dispose.
open class TimerSelectableTests {
    @Fact
    async func After_WinsAgainstNeverReadyChannel_ExactlyOnce() {
        let never = Chan[int32]()
        using let after = Timers.After(TimeSpan.FromMilliseconds(30))
        let w = SelectWaiter.Rent(2, CancellationToken.None)
        w.AddReceive[int32](never, 0)
        w.AddReceive[DateTime](after, 1)
        Assert.Equal(1, await w.WaitAsync().AsTask().WaitAsync(TimerSelectableTests.Timeout))
        Assert.True(w.Ok)
        Assert.NotEqual(default(DateTime), w.TakeValue[DateTime]())
        w.Return()
        Assert.Equal(0, never.RegisteredWaiterCount)
        // Drained: never fires again.
        Assert.False(after.TryReceive(out _, out _))
        let w2 = SelectWaiter.Rent(2, CancellationToken.None)
        w2.AddReceive[int32](never, 0)
        w2.AddReceive[DateTime](after, 1)
        let second = w2.WaitAsync().AsTask()
        await Task.Delay(100)
        Assert.False(second.IsCompleted)
        never.TrySend(1)
        Assert.Equal(0, await second.WaitAsync(TimerSelectableTests.Timeout))
        w2.Return()
    }

    @Fact
    async func After_AlreadyFired_IsReadyOnProbe() {
        using let after = Timers.After(TimeSpan.FromMilliseconds(10))
        await Task.Delay(100)
        Assert.True(after.HasFired)
        Assert.True(after.TryReceive(out var at, out var ok))
        Assert.True(ok)
        Assert.NotEqual(default(DateTime), at)
        Assert.False(after.TryReceive(out _, out _))
    }

    @Fact
    async func Tick_Repeats_AndDisposeStops() {
        let never = Chan[int32]()
        using let tick = Timers.Tick(TimeSpan.FromMilliseconds(20))
        for var i = 0; i < 3; i++ {
            let w = SelectWaiter.Rent(2, CancellationToken.None)
            w.AddReceive[int32](never, 0)
            w.AddReceive[DateTime](tick, 1)
            Assert.Equal(1, await w.WaitAsync().AsTask().WaitAsync(TimerSelectableTests.Timeout))
            w.Return()
        }
        tick.Dispose()
        await Task.Delay(60)
        tick.TryReceive(out _, out _) // drain any tick that landed before dispose
        await Task.Delay(60)
        Assert.False(tick.TryReceive(out _, out _))
    }

    @Fact
    async func Tick_HoldsAtMostOnePendingTick() {
        using let tick = Timers.Tick(TimeSpan.FromMilliseconds(10))
        await Task.Delay(150)
        Assert.True(tick.TryReceive(out _, out var ok))
        Assert.True(ok)
        // Only one was pending, however many periods elapsed.
        Assert.False(tick.TryReceive(out _, out _))
    }

    @Fact
    func Tick_RejectsNonPositivePeriod() {
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return Timers.Tick(TimeSpan.Zero)
            }
        )
    }

    shared {
        private let Timeout TimeSpan = TimeSpan.FromSeconds(10)
    }
}
