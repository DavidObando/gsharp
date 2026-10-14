// <copyright file="Timers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Collections.Generic
import System.Threading
import SystemObject = System.Object

/// Timer-backed selectables (ADR-0174 D8/D9): `after(d)` is Go's
/// `time.After`, `tick(d)` is `time.Tick`. They are not
/// channels and spawn no helper goroutine; a losing timer arm costs nothing
/// and leaks nothing. The G# functions in `Gsharp.Concurrency` forward here.
shared class Timers {
    /// Creates a one-shot selectable that becomes ready once after [`due`](paramref).
    /// @param due The delay. Armed at a whole number of milliseconds, rounded up (issue #4008), so a
    /// sub-millisecond delay is no longer truncated to an immediate fire.
    /// @returns The selectable.
    func After(due TimeSpan) AfterTimer -> AfterTimer(due)

    /// Creates a repeating selectable that becomes ready every [`period`](paramref), holding at most one
    /// pending tick.
    /// @param period The period. Must be positive; quantized up to a whole number of milliseconds (issue
    /// #4008), so 1 ms is the shortest period actually armed.
    /// @returns The selectable; dispose it to stop the ticks.
    func Tick(period TimeSpan) TickTimer -> TickTimer(period)

    /// Issue #4008: rounds a strictly positive interval UP to the next whole
    /// millisecond.
    ///
    /// (cref:Timer) TRUNCATES a (cref:TimeSpan) to whole
    /// milliseconds, so 1 ms is the finest interval either timer can actually be
    /// armed at. Truncation is the wrong rounding for a timer, in two ways. It
    /// arms SHORTER than the caller asked for — a `tick(1.5ms)` was armed
    /// at 1 ms and ran 50% fast. And at the bottom of the range it truncates a
    /// sub-millisecond interval to ZERO, which per the
    /// (cref:Timer.Change(TimeSpan, TimeSpan)) contract DISABLES periodic
    /// signalling: `tick(0.5ms)` produced exactly one tick and then went
    /// silent forever, with no error and no diagnostic.
    ///
    /// Rounding up fixes both with one rule — <b>an armed interval is never
    /// shorter than the one asked for</b> — and keeps a positive period
    /// ticking, which is what Go's `time.Ticker` promises and what a
    /// program ported from it expects. Zero and negative values —
    /// (cref:TimeSpan.Zero) for an immediate `after`,
    /// (cref:Timeout.InfiniteTimeSpan) for a disarmed timer — pass
    /// through untouched.
    /// @param interval The requested interval.
    /// @returns The interval to arm.
    internal func Quantize(interval TimeSpan) TimeSpan {
        if interval <= TimeSpan.Zero {
            return interval
        }
        let whole = interval.Ticks / TimeSpan.TicksPerMillisecond
        return if interval.Ticks % TimeSpan.TicksPerMillisecond == int64(0) {
            interval
        } else {
            TimeSpan.FromTicks((whole + int64(1)) * TimeSpan.TicksPerMillisecond)
        }
    }
}

/// A one-shot timer selectable: ready exactly once, after its delay, like a drained-once `time.After`
/// channel.
class AfterTimer : ISelectable[DateTime], ISelectableCore[DateTime], IDisposable {
    private let gate object = SystemObject()
    private let timer Timer
    private var waiters List[SelectNode[DateTime]]?
    private var fired bool
    private var consumed bool
    private var firedAt DateTime

    /// Initializes a new instance of the (cref:AfterTimer) class.
    /// @param due The delay. Armed at a whole number of milliseconds, rounded up (issue #4008), so a
    /// sub-millisecond delay is no longer truncated to an immediate fire.
    internal init(due TimeSpan) {
        Order = SelectOrder.Next()
        // Issue #4001: `new Timer(cb, state, due, period)` arms the timer before
        // it returns, so a short `due` lets `OnFire` run on a thread-pool thread
        // while `timer` is still unassigned — and `OnFire` ends in
        // `timer.Dispose()`. Construct disarmed, assign, then arm.
        timer = Timer(
            (state object?) -> (cast[AfterTimer](state!!)).OnFire(),
            this,
            Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan
        ) // state is `this`.
        // Issue #4008: `Timers.Quantize` rounds a sub-millisecond `due` up to
        // 1 ms rather than letting `Timer` truncate it to 0. `after` had no
        // failure mode here — a one-shot armed at 0 still fires — but it fired
        // essentially instantly, against Go's "at least `d`" contract for
        // `time.After`: measured over 200 samples, `after(0.9ms)` had a MEAN
        // latency of 0.007 ms before this change and lands with the 1 ms rows
        // (~1.19 ms) after it. `TimeSpan.Zero` is left alone, so `after(0)`
        // stays immediate.
        timer.Change(Timers.Quantize(due), Timeout.InfiniteTimeSpan)
    }

    /// Gets a value indicating whether the delay has elapsed (a snapshot).
    prop HasFired bool {
        get {
            lock gate {
                return fired
            }
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private prop(ISelectableCore[DateTime]) SelectOrder int64 -> Order

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private prop(ISelectableCore[DateTime]) SelectGate object? -> nil

    private prop Order int64 {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TryReceive(out value DateTime, out ok bool) bool {
        lock gate {
            if fired && !consumed {
                consumed = true
                value = firedAt
                ok = true
                return true
            }
        }
        value = default(DateTime)
        ok = false
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() -> timer.Dispose()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[DateTime]) TryReceiveLocked(
        out value DateTime,
        out ok bool,
        ref completions Completions
    ) bool -> TryReceive(out value, out ok)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[DateTime]) RegisterReceiveLocked(node SelectNode[DateTime]) {
        var deliver SelectNode[DateTime]? = nil
        lock gate {
            if fired && !consumed {
                consumed = true
                deliver = node
            } else if !fired {
                (
                    (
                        if waiters == nil {
                            (waiters = List[SelectNode[DateTime]]())
                        } else {
                            waiters
                        }
                    )!!
                ).Add(node)
            }
            // fired && consumed: the single value is gone; like a drained
            // time.After channel this arm can never fire again.

        }
        if deliver != nil {
            Deliver(deliver)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[DateTime]) Deregister(node SelectNode[DateTime]) {
        lock gate {
            waiters?.Remove(node)
        }
    }

    private func Deliver(node SelectNode[DateTime]) {
        if node.TryCommitReceive(firedAt) {
            node.Publish()
            return
        }
        // The node's select was already won elsewhere: the tick stays available.
        lock gate {
            consumed = false
        }
    }

    private func OnFire() {
        var winner SelectNode[DateTime]? = nil
        lock gate {
            fired = true
            firedAt = DateTime.UtcNow
            if waiters != nil {
                for node in waiters!! {
                    if node.TryCommitReceive(firedAt) {
                        consumed = true
                        winner = node
                        break
                    }
                }
                waiters = nil
            }
        }
        winner?.Publish()
        timer.Dispose()
    }
}

/// A repeating timer selectable holding at most one pending tick (ticks are dropped while one is
/// pending, as Go's ticker does).
/// @remarks The period must be positive, and is armed at a whole number of
/// milliseconds rounded UP (issue #4008): 1 ms is the shortest period this
/// timer can actually deliver, and a period of 1.5 ms ticks every 2 ms
/// rather than every 1 ms. Rounding up is what keeps a sub-millisecond
/// period ticking at all — see (cref:Timers.Quantize).
class TickTimer : ISelectable[DateTime], ISelectableCore[DateTime], IDisposable {
    private let gate object = SystemObject()
    private let timer Timer
    private let waiters List[SelectNode[DateTime]] = List[SelectNode[DateTime]]()
    private var pending bool
    private var pendingAt DateTime
    private var disposed bool

    /// Initializes a new instance of the (cref:TickTimer) class.
    /// @param period The period. Must be positive; armed at a whole number of milliseconds, rounded up
    /// (issue #4008).
    internal init(period TimeSpan) {
        if period <= TimeSpan.Zero {
            throw ArgumentOutOfRangeException("period", period, "Tick period must be positive.")
        }
        Order = SelectOrder.Next()
        // Issue #4001: armed only once the field is assigned, as in `AfterTimer`.
        // This constructor was *not* the crashing one — `OnTick` never touches
        // `timer` — but the two shapes stay identical so that adding a `timer.…`
        // to `OnTick` cannot quietly reintroduce that race.
        timer = Timer(
            (state object?) -> (cast[TickTimer](state!!)).OnTick(),
            this,
            Timeout.InfiniteTimeSpan,
            Timeout.InfiniteTimeSpan
        ) // state is `this`.
        // Issue #4008: arm the QUANTIZED period. Passing `period` straight
        // through let `Timer` truncate anything under 1 ms to a period of 0,
        // which disables periodic signalling — the ticker fired exactly once
        // and then went silent forever.
        let armed = Timers.Quantize(period)
        timer.Change(armed, armed)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private prop(ISelectableCore[DateTime]) SelectOrder int64 -> Order

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private prop(ISelectableCore[DateTime]) SelectGate object? -> nil

    private prop Order int64 {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TryReceive(out value DateTime, out ok bool) bool {
        lock gate {
            if pending {
                pending = false
                value = pendingAt
                ok = true
                return true
            }
        }
        value = default(DateTime)
        ok = false
        return false
    }

    /// Stops the ticks. Arms parked on a stopped ticker never fire, as with a stopped Go ticker.
    func Dispose() {
        lock gate {
            disposed = true
        }
        timer.Dispose()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[DateTime]) TryReceiveLocked(
        out value DateTime,
        out ok bool,
        ref completions Completions
    ) bool -> TryReceive(out value, out ok)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[DateTime]) RegisterReceiveLocked(node SelectNode[DateTime]) {
        var deliver SelectNode[DateTime]? = nil
        var at = default(DateTime)
        lock gate {
            if pending {
                pending = false
                at = pendingAt
                deliver = node
            } else {
                waiters.Add(node)
            }
        }
        if deliver == nil {
            return
        }
        if deliver.TryCommitReceive(at) {
            deliver.Publish()
            return
        }
        lock gate {
            pending = true
            pendingAt = at
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[DateTime]) Deregister(node SelectNode[DateTime]) {
        lock gate {
            waiters.Remove(node)
        }
    }

    private func OnTick() {
        var winner SelectNode[DateTime]? = nil
        lock gate {
            if disposed {
                return
            }
            let now = DateTime.UtcNow
            for var i = 0; i < waiters.Count; i++ {
                if waiters[i].TryCommitReceive(now) {
                    winner = waiters[i]
                    waiters.RemoveAt(i)
                    break
                }
            }
            if winner == nil {
                pending = true
                pendingAt = now
            }
        }
        winner?.Publish()
    }
}
