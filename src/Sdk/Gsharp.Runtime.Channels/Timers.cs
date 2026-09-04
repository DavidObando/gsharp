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
    /// <param name="due">The delay.</param>
    /// <returns>The selectable.</returns>
    public static AfterTimer After(TimeSpan due) => new(due);

    /// <summary>Creates a repeating selectable that becomes ready every <paramref name="period"/>, holding at most one pending tick.</summary>
    /// <param name="period">The period.</param>
    /// <returns>The selectable; dispose it to stop the ticks.</returns>
    public static TickTimer Tick(TimeSpan period) => new(period);
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
    /// <param name="due">The delay.</param>
    internal AfterTimer(TimeSpan due)
    {
        Order = SelectOrder.Next();
        timer = new Timer(static state => ((AfterTimer)state!).OnFire(), this, due, Timeout.InfiniteTimeSpan); // state is `this`.
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
public sealed class TickTimer : ISelectable<DateTime>, ISelectableCore<DateTime>, IDisposable
{
    private readonly object gate = new();
    private readonly Timer timer;
    private readonly List<SelectNode<DateTime>> waiters = new();
    private bool pending;
    private DateTime pendingAt;
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="TickTimer"/> class.</summary>
    /// <param name="period">The period.</param>
    internal TickTimer(TimeSpan period)
    {
        if (period <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(period), period, "Tick period must be positive.");
        }

        Order = SelectOrder.Next();
        timer = new Timer(static state => ((TickTimer)state!).OnTick(), this, period, period); // state is `this`.
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
