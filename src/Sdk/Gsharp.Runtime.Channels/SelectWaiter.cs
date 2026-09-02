// <copyright file="SelectWaiter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;
using System.Threading.Tasks.Sources;

namespace Gsharp.Concurrency;

/// <summary>
/// The single registered waiter behind a parked G# <c>select</c> (ADR-0174 D8).
/// One instance is registered in the waiter queue of every arm's channel; the
/// first counterpart to reach it CAS-claims a <em>generation-stamped</em>
/// winner slot and transfers the value in the same step, so winning
/// <em>is</em> the transfer. Losers are deregistered by <see cref="Return"/>
/// before the arm body runs. Registration acquires every distinct channel
/// gate in ascending <see cref="Chan{T}.Id"/> order (a total order, so
/// selects over overlapping channel sets cannot deadlock) and re-probes every
/// arm under the locks before parking, which closes the readiness/commit gap
/// for G# channels. Foreign BCL channels, <see cref="Task"/>s, timers and the
/// ambient cancellation claim the same slot from their own callbacks; a
/// foreign arm reports <see cref="NeedsReprobe"/> because readiness on a
/// public <c>ChannelReader</c> does not reserve an item.
/// </summary>
/// <remarks>
/// The emitted protocol is: <c>Rent</c>, <c>Add*</c> per arm, <c>await WaitAsync()</c>
/// (winning arm index; throws the ambient cancellation or a send-on-closed),
/// <c>NeedsReprobe</c> → <c>Return</c> and loop, else <c>TakeValue</c>/<c>Ok</c>
/// for a receive arm, then <c>Return</c>. Waiters are pooled per thread; a
/// stale claim against a reused waiter is defeated by the generation check.
/// </remarks>
public sealed class SelectWaiter : IValueTaskSource<int>
{
    private const int StatePending = 0;
    private const int StateClaimed = 1;
    private const int StateIdle = 2;
    private const int StateBits = 2;

    [ThreadStatic]
    private static SelectWaiter? cache;

    private readonly List<ArmDescriptor> arms = new();
    private readonly List<(long Order, object Gate)> gates = new();
    private ManualResetValueTaskSourceCore<int> core;
    private long word = StateIdle;
    private int winnerArm = -1;
    private object? value;
    private bool ok;
    private bool needsReprobe;
    private Exception? fault;
    private CancellationToken token;
    private CancellationTokenRegistration tokenRegistration;
    private bool hasTokenRegistration;
    private int cancelledArm = -1;
    private bool canPool = true;

    private SelectWaiter()
    {
        core.RunContinuationsAsynchronously = true;
    }

    /// <summary>Gets a value indicating whether the winning arm was a foreign channel whose readiness must be re-probed (the transfer did not happen yet).</summary>
    public bool NeedsReprobe => needsReprobe;

    /// <summary>Gets a value indicating whether the winning receive arm delivered a value (false: its channel is closed).</summary>
    public bool Ok => ok;

    /// <summary>Gets the current generation; a claim must carry it to succeed.</summary>
    internal long Generation => Volatile.Read(ref word) >> StateBits;

    /// <summary>Gets the number of registered arms. Diagnostic.</summary>
    internal int ArmCount => arms.Count;

    /// <summary>Rents a waiter for a select with the given ambient cancellation.</summary>
    /// <param name="arms">The number of arms the select has (a capacity hint).</param>
    /// <param name="cancellationToken">The ambient context's token.</param>
    /// <returns>A pending waiter.</returns>
    public static SelectWaiter Rent(int arms, CancellationToken cancellationToken)
    {
        var waiter = cache;
        cache = null;
        waiter ??= new SelectWaiter();
        waiter.Begin(cancellationToken);
        return waiter;
    }

    /// <summary>Adds a receive arm over a G# channel. The most specific overload: a <see cref="Chan{T}"/> is both a <see cref="Channel{T}"/> and an <see cref="ISelectable{T}"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel; <c>nil</c> disables the arm.</param>
    /// <param name="arm">The arm index.</param>
    public void AddReceive<T>(Chan<T>? channel, int arm)
    {
        if (channel is not null)
        {
            arms.Add(new CoreReceiveArm<T>(channel, arm));
        }
    }

    /// <summary>Adds a receive arm over a channel (fast path when it is a <see cref="Chan{T}"/>, re-probe fallback otherwise).</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel; <c>nil</c> disables the arm.</param>
    /// <param name="arm">The arm index.</param>
    public void AddReceive<T>(Channel<T>? channel, int arm)
    {
        switch (channel)
        {
            case Chan<T> chan:
                arms.Add(new CoreReceiveArm<T>(chan, arm));
                break;
            case null:
                break;
            default:
                arms.Add(new ForeignReceiveArm<T>(channel.Reader, arm));
                break;
        }
    }

    /// <summary>Adds a receive arm over a receive-only handle.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader; <c>nil</c> disables the arm.</param>
    /// <param name="arm">The arm index.</param>
    public void AddReceive<T>(ChannelReader<T>? reader, int arm)
    {
        switch (reader)
        {
            case Chan<T>.ChanReader owned:
                arms.Add(new CoreReceiveArm<T>(owned.Owner, arm));
                break;
            case null:
                break;
            default:
                arms.Add(new ForeignReceiveArm<T>(reader, arm));
                break;
        }
    }

    /// <summary>Adds a receive arm over a runtime selectable such as <c>after(d)</c> or <c>tick(d)</c>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="selectable">The selectable; <c>nil</c> disables the arm.</param>
    /// <param name="arm">The arm index.</param>
    public void AddReceive<T>(ISelectable<T>? selectable, int arm)
    {
        switch (selectable)
        {
            case ISelectableCore<T> core:
                arms.Add(new CoreReceiveArm<T>(core, arm));
                break;
            case null:
                break;
            default:
                throw new NotSupportedException($"'{selectable.GetType()}' cannot participate in select: only runtime-owned selectables register a waiter.");
        }
    }

    /// <summary>Adds a send arm over a G# channel (the most specific overload).</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel; <c>nil</c> disables the arm.</param>
    /// <param name="value">The value the arm offers.</param>
    /// <param name="arm">The arm index.</param>
    public void AddSend<T>(Chan<T>? channel, T value, int arm)
    {
        if (channel is not null)
        {
            arms.Add(new CoreSendArm<T>(channel, value, arm));
        }
    }

    /// <summary>Adds a send arm over a channel.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel; <c>nil</c> disables the arm.</param>
    /// <param name="value">The value the arm offers.</param>
    /// <param name="arm">The arm index.</param>
    public void AddSend<T>(Channel<T>? channel, T value, int arm)
    {
        switch (channel)
        {
            case Chan<T> chan:
                arms.Add(new CoreSendArm<T>(chan, value, arm));
                break;
            case null:
                break;
            default:
                arms.Add(new ForeignSendArm<T>(channel.Writer, value, arm));
                break;
        }
    }

    /// <summary>Adds a send arm over a send-only handle.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The writer; <c>nil</c> disables the arm.</param>
    /// <param name="value">The value the arm offers.</param>
    /// <param name="arm">The arm index.</param>
    public void AddSend<T>(ChannelWriter<T>? writer, T value, int arm)
    {
        switch (writer)
        {
            case Chan<T>.ChanWriter owned:
                arms.Add(new CoreSendArm<T>(owned.Owner, value, arm));
                break;
            case null:
                break;
            default:
                arms.Add(new ForeignSendArm<T>(writer, value, arm));
                break;
        }
    }

    /// <summary>Adds a <c>case await task</c> arm.</summary>
    /// <param name="task">The task.</param>
    /// <param name="arm">The arm index.</param>
    public void AddTask(Task task, int arm) => arms.Add(new TaskArm(task, arm));

    /// <summary>Adds a <c>case let v = await task</c> arm.</summary>
    /// <typeparam name="T">The task result type.</typeparam>
    /// <param name="task">The task.</param>
    /// <param name="arm">The arm index.</param>
    public void AddTask<T>(Task<T> task, int arm) => arms.Add(new TaskArm<T>(task, arm));

    /// <summary>
    /// Adds a <c>case cancelled</c> arm. With it, cancellation of the ambient
    /// context selects this arm instead of throwing out of the select.
    /// </summary>
    /// <param name="arm">The arm index.</param>
    public void AddCancelled(int arm) => cancelledArm = arm;

    /// <summary>
    /// Registers every arm and parks. Completes with the winning arm index.
    /// Throws <see cref="OperationCanceledException"/> when the ambient context
    /// is cancelled and no <c>cancelled</c> arm exists, <see cref="ChannelClosedException"/>
    /// when a send arm's channel closes, or a winning task arm's fault.
    /// </summary>
    /// <returns>The winning arm.</returns>
    public ValueTask<int> WaitAsync()
    {
        var generation = Generation;
        var completions = default(Completions);
        var wonSynchronously = false;

        // Phase 1: acquire every distinct gate in ascending order.
        CollectGates();
        var taken = 0;
        try
        {
            for (; taken < gates.Count; taken++)
            {
                Monitor.Enter(gates[taken].Gate);
            }

            // Phase 2: re-probe the gated arms under the locks, from a random start.
            var count = arms.Count;
            var start = count > 0 ? SelectRandom.Next(count) : 0;
            for (var k = 0; k < count && !wonSynchronously; k++)
            {
                var descriptor = arms[(start + k) % count];
                if (descriptor.RequiresGate && descriptor.TryProbe(this, ref completions))
                {
                    Claim(generation, descriptor.Arm);
                    wonSynchronously = true;
                }
            }

            if (!wonSynchronously && cancelledArm >= 0 && token.IsCancellationRequested)
            {
                Claim(generation, cancelledArm);
                Deposit(null, ok: true, needsReprobe: false);
                wonSynchronously = true;
            }

            // Phase 3: register the gated arms while still holding every lock,
            // so no arm can become ready-and-unobserved mid-registration.
            if (!wonSynchronously)
            {
                foreach (var descriptor in arms)
                {
                    if (descriptor.RequiresGate)
                    {
                        descriptor.Register(this, generation);
                    }
                }
            }
        }
        finally
        {
            for (var i = taken - 1; i >= 0; i--)
            {
                Monitor.Exit(gates[i].Gate);
            }
        }

        completions.Publish();
        if (wonSynchronously)
        {
            return fault is null ? new ValueTask<int>(winnerArm) : ValueTask.FromException<int>(fault);
        }

        // Phase 4: arms that lock privately or have no lock (timers, foreign
        // channels, tasks) — they may claim synchronously during registration.
        foreach (var descriptor in arms)
        {
            if (!descriptor.RequiresGate)
            {
                descriptor.Register(this, generation);
            }
        }

        // Phase 5: the ambient cancellation, last, so a token that is already
        // cancelled resolves inline against a fully registered waiter.
        if (token.CanBeCanceled)
        {
            hasTokenRegistration = true;
            tokenRegistration = token.UnsafeRegister(static (state, _) => ((SelectWaiter)state!).OnCancelled(), this);
        }

        return new ValueTask<int>(this, core.Version);
    }

    /// <summary>Takes the value delivered to the winning receive arm.</summary>
    /// <typeparam name="T">The arm's element type.</typeparam>
    /// <returns>The value, or the zero value when <see cref="Ok"/> is false.</returns>
    public T TakeValue<T>()
    {
        var taken = value;
        value = null;
        return taken is null ? default! : (T)taken;
    }

    /// <summary>Deregisters every losing arm, tears down callbacks, and pools the waiter. Call exactly once per <see cref="Rent"/>.</summary>
    public void Return()
    {
        foreach (var descriptor in arms)
        {
            descriptor.Deregister();
        }

        if (hasTokenRegistration)
        {
            // False when the callback ran or is running: never reuse then.
            canPool &= tokenRegistration.Unregister();
        }

        arms.Clear();
        gates.Clear();
        winnerArm = -1;
        value = null;
        ok = false;
        needsReprobe = false;
        fault = null;
        token = default;
        tokenRegistration = default;
        hasTokenRegistration = false;
        cancelledArm = -1;

        var generation = Generation;
        Volatile.Write(ref word, (generation << StateBits) | StateIdle);
        if (canPool)
        {
            core.Reset();
            cache = this;
        }
    }

    /// <inheritdoc/>
    int IValueTaskSource<int>.GetResult(short token) => core.GetResult(token);

    /// <inheritdoc/>
    ValueTaskSourceStatus IValueTaskSource<int>.GetStatus(short token) => core.GetStatus(token);

    /// <inheritdoc/>
    void IValueTaskSource<int>.OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        => core.OnCompleted(continuation, state, token, flags);

    /// <summary>
    /// The one CAS every claimer performs: <c>(generation, Pending) → (generation, Claimed)</c>.
    /// Fails for a stale generation (a pooled waiter reused since the
    /// registration was made) and for an already-claimed waiter.
    /// </summary>
    /// <param name="generation">The generation the registration was made under.</param>
    /// <param name="arm">The arm claiming.</param>
    /// <returns>True when this call won.</returns>
    internal bool TryClaim(long generation, int arm)
    {
        var expected = (generation << StateBits) | StatePending;
        var desired = (generation << StateBits) | StateClaimed;
        if (Interlocked.CompareExchange(ref word, desired, expected) != expected)
        {
            return false;
        }

        winnerArm = arm;
        return true;
    }

    /// <summary>Deposits a receive arm's outcome. Only the claimer calls this, after <see cref="TryClaim"/>.</summary>
    /// <param name="deposited">The value (boxed for value types on the slow path).</param>
    /// <param name="ok">Whether a value was delivered.</param>
    /// <param name="needsReprobe">Whether the arm only signalled readiness.</param>
    internal void Deposit(object? deposited, bool ok, bool needsReprobe)
    {
        value = deposited;
        this.ok = ok;
        this.needsReprobe = needsReprobe;
    }

    /// <summary>Deposits a fault the winning arm surfaces from <see cref="WaitAsync"/>.</summary>
    /// <param name="exception">The fault.</param>
    internal void DepositFault(Exception exception) => fault = exception;

    /// <summary>Fires the select's continuation. Called exactly once, by the claimer, outside every channel lock.</summary>
    internal void PublishOutcome()
    {
        if (fault is not null)
        {
            core.SetException(fault);
        }
        else
        {
            core.SetResult(winnerArm);
        }
    }

    /// <summary>Collects the distinct gates of the gated arms, sorted ascending by their total-order key.</summary>
    /// <returns>The sorted gate list (for tests).</returns>
    internal IReadOnlyList<(long Order, object Gate)> CollectGates()
    {
        gates.Clear();
        foreach (var descriptor in arms)
        {
            if (descriptor.Gate is not { } gate)
            {
                continue;
            }

            var seen = false;
            foreach (var existing in gates)
            {
                if (ReferenceEquals(existing.Gate, gate))
                {
                    seen = true;
                    break;
                }
            }

            if (!seen)
            {
                gates.Add((descriptor.Order, gate));
            }
        }

        gates.Sort(static (a, b) => a.Order.CompareTo(b.Order));
        return gates;
    }

    private void Begin(CancellationToken cancellationToken)
    {
        var generation = Generation + 1;
        Volatile.Write(ref word, (generation << StateBits) | StatePending);
        token = cancellationToken;
        canPool = true;
    }

    private void Claim(long generation, int arm)
    {
        if (!TryClaim(generation, arm))
        {
            throw new InvalidOperationException("select waiter was claimed while every gate was held");
        }
    }

    private void OnCancelled()
    {
        var generation = Generation;
        if (cancelledArm >= 0)
        {
            if (TryClaim(generation, cancelledArm))
            {
                Deposit(null, ok: true, needsReprobe: false);
                PublishOutcome();
            }

            return;
        }

        if (TryClaim(generation, -1))
        {
            DepositFault(new OperationCanceledException(token));
            PublishOutcome();
        }
    }
}
