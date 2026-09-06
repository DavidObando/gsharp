// <copyright file="Timers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Timer-backed selectables (ADR-0174 D8/D9): <c>after(d)</c> is Go's
/// <c>time.After</c>, <c>tick(d)</c> is <c>time.Tick</c>. They are not
/// channels and spawn no helper goroutine; a losing timer arm costs nothing
/// and leaks nothing. The G# functions in <c>Gsharp.Concurrency</c> forward here.
/// </summary>
public static class Timers
{
    /// <summary>Creates a one-shot selectable that becomes ready once after <paramref name="due"/>.</summary>
    /// <param name="due">The delay. Armed at a whole number of milliseconds, rounded up (issue #4008), so a sub-millisecond delay is no longer truncated to an immediate fire.</param>
    /// <returns>The selectable.</returns>
    public static AfterTimer After(TimeSpan due) => new(due);

    /// <summary>Creates a repeating selectable that becomes ready every <paramref name="period"/>, holding at most one pending tick.</summary>
    /// <param name="period">The period. Must be positive; quantized up to a whole number of milliseconds (issue #4008), so 1 ms is the shortest period actually armed.</param>
    /// <returns>The selectable; dispose it to stop the ticks.</returns>
    public static TickTimer Tick(TimeSpan period) => new(period);

    /// <summary>
    /// Issue #4008: rounds a strictly positive interval UP to the next whole
    /// millisecond.
    /// <para>
    /// <see cref="Timer"/> TRUNCATES a <see cref="TimeSpan"/> to whole
    /// milliseconds, so 1 ms is the finest interval either timer can actually be
    /// armed at. Truncation is the wrong rounding for a timer, in two ways. It
    /// arms SHORTER than the caller asked for — a <c>tick(1.5ms)</c> was armed
    /// at 1 ms and ran 50% fast. And at the bottom of the range it truncates a
    /// sub-millisecond interval to ZERO, which per the
    /// <see cref="Timer.Change(TimeSpan, TimeSpan)"/> contract DISABLES periodic
    /// signalling: <c>tick(0.5ms)</c> produced exactly one tick and then went
    /// silent forever, with no error and no diagnostic.
    /// </para>
    /// <para>
    /// Rounding up fixes both with one rule — <b>an armed interval is never
    /// shorter than the one asked for</b> — and keeps a positive period
    /// ticking, which is what Go's <c>time.Ticker</c> promises and what a
    /// program ported from it expects. Zero and negative values —
    /// <see cref="TimeSpan.Zero"/> for an immediate <c>after</c>,
    /// <see cref="Timeout.InfiniteTimeSpan"/> for a disarmed timer — pass
    /// through untouched.
    /// </para>
    /// </summary>
    /// <param name="interval">The requested interval.</param>
    /// <returns>The interval to arm.</returns>
    internal static TimeSpan Quantize(TimeSpan interval)
    {
        if (interval <= TimeSpan.Zero)
        {
            return interval;
        }

        var whole = interval.Ticks / TimeSpan.TicksPerMillisecond;
        return interval.Ticks % TimeSpan.TicksPerMillisecond == 0
            ? interval
            : TimeSpan.FromTicks((whole + 1) * TimeSpan.TicksPerMillisecond);
    }
}

/// <summary>A one-shot timer selectable: ready exactly once, after its delay, like a drained-once <c>time.After</c> channel.</summary>
public sealed class AfterTimer : ISelectable<DateTime>, ISelectableCore<DateTime>, IDisposable
{
    private readonly object gate = new();
    private readonly Timer timer;
    private List<SelectNode<DateTime>>? waiters;
    private bool fired;
    private bool consumed;
    private DateTime firedAt;

    /// <summary>Initializes a new instance of the <see cref="AfterTimer"/> class.</summary>
    /// <param name="due">The delay. Armed at a whole number of milliseconds, rounded up (issue #4008), so a sub-millisecond delay is no longer truncated to an immediate fire.</param>
    internal AfterTimer(TimeSpan due)
    {
        Order = SelectOrder.Next();

        // Issue #4001: `new Timer(cb, state, due, period)` arms the timer before
        // it returns, so a short `due` lets `OnFire` run on a thread-pool thread
        // while `timer` is still unassigned — and `OnFire` ends in
        // `timer.Dispose()`. Construct disarmed, assign, then arm.
        timer = new Timer(static state => ((AfterTimer)state!).OnFire(), this, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan); // state is `this`.

        // Issue #4008: `Timers.Quantize` rounds a sub-millisecond `due` up to
        // 1 ms rather than letting `Timer` truncate it to 0. `after` had no
        // failure mode here — a one-shot armed at 0 still fires — but it fired
        // essentially instantly, against Go's "at least `d`" contract for
        // `time.After`: measured over 200 samples, `after(0.9ms)` had a MEAN
        // latency of 0.007 ms before this change and lands with the 1 ms rows
        // (~1.19 ms) after it. `TimeSpan.Zero` is left alone, so `after(0)`
        // stays immediate.
        timer.Change(Timers.Quantize(due), Timeout.InfiniteTimeSpan);
    }

    /// <summary>Gets a value indicating whether the delay has elapsed (a snapshot).</summary>
    public bool HasFired
    {
        get
        {
            lock (gate)
            {
                return fired;
            }
        }
    }

    /// <inheritdoc/>
    long ISelectableCore<DateTime>.SelectOrder => Order;

    /// <inheritdoc/>
    object? ISelectableCore<DateTime>.SelectGate => null;

    private long Order { get; }

    /// <inheritdoc/>
    public bool TryReceive(out DateTime value, out bool ok)
    {
        lock (gate)
        {
            if (fired && !consumed)
            {
                consumed = true;
                value = firedAt;
                ok = true;
                return true;
            }
        }

        value = default;
        ok = false;
        return false;
    }

    /// <inheritdoc/>
    public void Dispose() => timer.Dispose();

    /// <inheritdoc/>
    bool ISelectableCore<DateTime>.TryReceiveLocked(out DateTime value, out bool ok, ref Completions completions) => TryReceive(out value, out ok);

    /// <inheritdoc/>
    void ISelectableCore<DateTime>.RegisterReceiveLocked(SelectNode<DateTime> node)
    {
        SelectNode<DateTime>? deliver = null;
        lock (gate)
        {
            if (fired && !consumed)
            {
                consumed = true;
                deliver = node;
            }
            else if (!fired)
            {
                (waiters ??= new List<SelectNode<DateTime>>()).Add(node);
            }

            // fired && consumed: the single value is gone; like a drained
            // time.After channel this arm can never fire again.
        }

        if (deliver is not null)
        {
            Deliver(deliver);
        }
    }

    /// <inheritdoc/>
    void ISelectableCore<DateTime>.Deregister(SelectNode<DateTime> node)
    {
        lock (gate)
        {
            waiters?.Remove(node);
        }
    }

    private void Deliver(SelectNode<DateTime> node)
    {
        if (node.TryCommitReceive(firedAt))
        {
            node.Publish();
            return;
        }

        // The node's select was already won elsewhere: the tick stays available.
        lock (gate)
        {
            consumed = false;
        }
    }

    private void OnFire()
    {
        SelectNode<DateTime>? winner = null;
        lock (gate)
        {
            fired = true;
            firedAt = DateTime.UtcNow;
            if (waiters is not null)
            {
                foreach (var node in waiters)
                {
                    if (node.TryCommitReceive(firedAt))
                    {
                        consumed = true;
                        winner = node;
                        break;
                    }
                }

                waiters = null;
            }
        }

        winner?.Publish();
        timer.Dispose();
    }
}

/// <summary>A repeating timer selectable holding at most one pending tick (ticks are dropped while one is pending, as Go's ticker does).</summary>
/// <remarks>
/// The period must be positive, and is armed at a whole number of
/// milliseconds rounded UP (issue #4008): 1 ms is the shortest period this
/// timer can actually deliver, and a period of 1.5 ms ticks every 2 ms
/// rather than every 1 ms. Rounding up is what keeps a sub-millisecond
/// period ticking at all — see <see cref="Timers.Quantize"/>.
/// </remarks>
public sealed class TickTimer : ISelectable<DateTime>, ISelectableCore<DateTime>, IDisposable
{
    private readonly object gate = new();
    private readonly Timer timer;
    private readonly List<SelectNode<DateTime>> waiters = new();
    private bool pending;
    private DateTime pendingAt;
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="TickTimer"/> class.</summary>
    /// <param name="period">The period. Must be positive; armed at a whole number of milliseconds, rounded up (issue #4008).</param>
    internal TickTimer(TimeSpan period)
    {
        if (period <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(period), period, "Tick period must be positive.");
        }

        Order = SelectOrder.Next();

        // Issue #4001: armed only once the field is assigned, as in `AfterTimer`.
        // This constructor was *not* the crashing one — `OnTick` never touches
        // `timer` — but the two shapes stay identical so that adding a `timer.…`
        // to `OnTick` cannot quietly reintroduce that race.
        timer = new Timer(static state => ((TickTimer)state!).OnTick(), this, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan); // state is `this`.

        // Issue #4008: arm the QUANTIZED period. Passing `period` straight
        // through let `Timer` truncate anything under 1 ms to a period of 0,
        // which disables periodic signalling — the ticker fired exactly once
        // and then went silent forever.
        var armed = Timers.Quantize(period);
        timer.Change(armed, armed);
    }

    /// <inheritdoc/>
    long ISelectableCore<DateTime>.SelectOrder => Order;

    /// <inheritdoc/>
    object? ISelectableCore<DateTime>.SelectGate => null;

    private long Order { get; }

    /// <inheritdoc/>
    public bool TryReceive(out DateTime value, out bool ok)
    {
        lock (gate)
        {
            if (pending)
            {
                pending = false;
                value = pendingAt;
                ok = true;
                return true;
            }
        }

        value = default;
        ok = false;
        return false;
    }

    /// <summary>Stops the ticks. Arms parked on a stopped ticker never fire, as with a stopped Go ticker.</summary>
    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
        }

        timer.Dispose();
    }

    /// <inheritdoc/>
    bool ISelectableCore<DateTime>.TryReceiveLocked(out DateTime value, out bool ok, ref Completions completions) => TryReceive(out value, out ok);

    /// <inheritdoc/>
    void ISelectableCore<DateTime>.RegisterReceiveLocked(SelectNode<DateTime> node)
    {
        SelectNode<DateTime>? deliver = null;
        DateTime at = default;
        lock (gate)
        {
            if (pending)
            {
                pending = false;
                at = pendingAt;
                deliver = node;
            }
            else
            {
                waiters.Add(node);
            }
        }

        if (deliver is null)
        {
            return;
        }

        if (deliver.TryCommitReceive(at))
        {
            deliver.Publish();
            return;
        }

        lock (gate)
        {
            pending = true;
            pendingAt = at;
        }
    }

    /// <inheritdoc/>
    void ISelectableCore<DateTime>.Deregister(SelectNode<DateTime> node)
    {
        lock (gate)
        {
            waiters.Remove(node);
        }
    }

    private void OnTick()
    {
        SelectNode<DateTime>? winner = null;
        lock (gate)
        {
            if (disposed)
            {
                return;
            }

            var now = DateTime.UtcNow;
            for (var i = 0; i < waiters.Count; i++)
            {
                if (waiters[i].TryCommitReceive(now))
                {
                    winner = waiters[i];
                    waiters.RemoveAt(i);
                    break;
                }
            }

            if (winner is null)
            {
                pending = true;
                pendingAt = now;
            }
        }

        winner?.Publish();
    }
}
