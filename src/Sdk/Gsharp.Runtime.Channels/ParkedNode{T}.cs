// <copyright file="ParkedNode{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;
using System.Threading.Tasks.Sources;

namespace Gsharp.Concurrency;

/// <summary>
/// Shared state machine of a single-operation parked node: a CAS-guarded
/// <c>Pending → Committed | Faulted</c> transition, an optional cancellation
/// registration, and deferred publication. The claim (state transition plus
/// value deposit) happens under the channel lock; publication happens after.
/// </summary>
/// <typeparam name="T">The channel element type.</typeparam>
internal abstract class ParkedNode<T> : WaiterNode<T>
{
    /// <summary>The node is parked and may still be claimed, cancelled, or closed.</summary>
    protected const int Pending = 0;

    /// <summary>A transfer (or a close) committed to this node.</summary>
    protected const int Committed = 1;

    /// <summary>The node was cancelled or the channel closed on a sender.</summary>
    protected const int Faulted = 2;

    private readonly Chan<T> owner;
    private int state;
    private Exception? fault;
    private CancellationTokenRegistration registration;
    private bool hasRegistration;
    private bool published;

    /// <summary>Initializes a new instance of the <see cref="ParkedNode{T}"/> class.</summary>
    /// <param name="owner">The channel this node parks on.</param>
    protected ParkedNode(Chan<T> owner)
    {
        this.owner = owner;
    }

    /// <summary>
    /// Gets a value indicating whether the node may be returned to its pool
    /// after its result is consumed: false when a cancellation callback may
    /// still be in flight against it (a stale callback must never see a
    /// reused node — the ABA hazard ADR-0174 D8 names for pooled waiters).
    /// </summary>
    internal bool CanPool { get; private set; } = true;

    /// <summary>Gets the channel this node parks on.</summary>
    protected Chan<T> Owner => owner;

    /// <summary>Gets a value indicating whether a transfer committed to this node.</summary>
    protected bool IsCommitted => Volatile.Read(ref state) == Committed;

    /// <summary>
    /// Gets a value indicating whether this node's continuation may run on the
    /// publishing thread (issue #3902 H1). False for notifiers: their
    /// continuation is a BCL <c>WaitToReadAsync</c> consumer, which
    /// <see cref="System.Threading.Channels.Channel{T}"/> itself completes
    /// asynchronously for the same reason.
    /// </summary>
    protected virtual bool AllowsInlineCompletion => true;

    /// <inheritdoc/>
    internal sealed override bool TryCancel(OperationCanceledException exception) => TryFault(exception);

    /// <inheritdoc/>
    internal sealed override void Publish()
    {
        if (published)
        {
            return;
        }

        published = true;
        if (hasRegistration)
        {
            // Unregister returns false when the callback already ran or is
            // running; either way the node must not be reused.
            CanPool = registration.Unregister();
        }

        // Issue #3902 H1 / ADR-0174 gate G6: complete the awaiter's
        // continuation on this thread when the budget allows, instead of
        // queueing a thread-pool work item and waiting for another thread to
        // steal it. Publication already happens outside every channel lock,
        // which is what makes this admissible at all.
        var inline = AllowsInlineCompletion && InlineBudget.TryEnter();
        try
        {
            SetRunContinuationsAsynchronously(!inline);
            if (Volatile.Read(ref state) == Committed)
            {
                PublishResult();
            }
            else
            {
                PublishException(fault!);
            }
        }
        finally
        {
            if (inline)
            {
                InlineBudget.Exit();
            }
        }
    }

    /// <summary>
    /// Registers cancellation. Called under the channel lock after the node is
    /// linked, so a token that is already cancelled runs the callback inline
    /// (re-entering the lock) and faults the node before the caller returns it.
    /// </summary>
    /// <param name="token">The token to observe.</param>
    internal void RegisterCancellation(CancellationToken token)
    {
        if (!token.CanBeCanceled)
        {
            return;
        }

        hasRegistration = true;
        registration = token.UnsafeRegister(
            static (state, token) =>
            {
                // The state is `this`, handed to UnsafeRegister just below.
                var node = (ParkedNode<T>)state!;
                node.owner.CancelParkedNode(node, token);
            },
            this);
    }

    /// <summary>Attempts the <c>Pending → target</c> transition.</summary>
    /// <param name="target">The target state.</param>
    /// <returns>True when this call performed the transition.</returns>
    protected bool TryTransition(int target) => Interlocked.CompareExchange(ref state, target, Pending) == Pending;

    /// <summary>Attempts to fault the node.</summary>
    /// <param name="exception">The fault.</param>
    /// <returns>True when this call faulted the node.</returns>
    protected bool TryFault(Exception exception)
    {
        if (!TryTransition(Faulted))
        {
            return false;
        }

        fault = exception;
        return true;
    }

    /// <summary>Points the node's value-task source at inline or queued completion.</summary>
    /// <param name="value">Whether continuations must be queued.</param>
    protected abstract void SetRunContinuationsAsynchronously(bool value);

    /// <summary>Publishes the committed result to the awaiter.</summary>
    protected abstract void PublishResult();

    /// <summary>Publishes a fault to the awaiter.</summary>
    /// <param name="exception">The fault.</param>
    protected abstract void PublishException(Exception exception);

    /// <summary>Resets the shared state for pooling.</summary>
    protected void ResetCore()
    {
        state = Pending;
        fault = null;
        registration = default;
        hasRegistration = false;
        published = false;
        CanPool = true;
    }
}

/// <summary>A parked receiver: the awaitable behind <see cref="Chan{T}.ReceiveAsync"/>.</summary>
/// <typeparam name="T">The channel element type.</typeparam>
internal sealed class OpReceiveNode<T>
    : ParkedNode<T>,
      IValueTaskSource<ReceiveResult<T>>,
      IValueTaskSource<T>,
      IValueTaskSource<(T Value, bool Ok)>
{
    private ManualResetValueTaskSourceCore<ReceiveResult<T>> core;
    private ReceiveResult<T> result;

    /// <summary>Initializes a new instance of the <see cref="OpReceiveNode{T}"/> class.</summary>
    /// <param name="owner">The channel this node parks on.</param>
    internal OpReceiveNode(Chan<T> owner)
        : base(owner)
    {
        core.RunContinuationsAsynchronously = true;
    }

    /// <summary>Gets the current <see cref="ValueTask"/> token; bumped on every reuse.</summary>
    internal short Version => core.Version;

    /// <inheritdoc/>
    internal override bool IsNotify => false;

    /// <inheritdoc/>
    ReceiveResult<T> IValueTaskSource<ReceiveResult<T>>.GetResult(short token) => TakeResult(token);

    /// <inheritdoc/>
    ValueTaskSourceStatus IValueTaskSource<ReceiveResult<T>>.GetStatus(short token) => core.GetStatus(token);

    /// <inheritdoc/>
    void IValueTaskSource<ReceiveResult<T>>.OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        => core.OnCompleted(continuation, state, token, flags);

    // The single-value shape. A closed, drained channel yields the zero value
    // by design (ADR-0174 D3), so there is no null to guard.

    /// <inheritdoc/>
    T IValueTaskSource<T>.GetResult(short token) => TakeResult(token).Value!;

    /// <inheritdoc/>
    ValueTaskSourceStatus IValueTaskSource<T>.GetStatus(short token) => core.GetStatus(token);

    /// <inheritdoc/>
    void IValueTaskSource<T>.OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        => core.OnCompleted(continuation, state, token, flags);

    // The two-value shape: the tuple IS the three-state encoding (D3).

    /// <inheritdoc/>
    (T Value, bool Ok) IValueTaskSource<(T Value, bool Ok)>.GetResult(short token)
    {
        var taken = TakeResult(token);
        return (taken.Value!, taken.Ok);
    }

    /// <inheritdoc/>
    ValueTaskSourceStatus IValueTaskSource<(T Value, bool Ok)>.GetStatus(short token) => core.GetStatus(token);

    /// <inheritdoc/>
    void IValueTaskSource<(T Value, bool Ok)>.OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        => core.OnCompleted(continuation, state, token, flags);

    /// <inheritdoc/>
    internal override bool TryCommitReceive(T value)
    {
        if (!TryTransition(Committed))
        {
            return false;
        }

        result = new ReceiveResult<T>(value, true);
        return true;
    }

    /// <inheritdoc/>
    internal override bool TryCommitSend([MaybeNullWhen(false)] out T value)
    {
        value = default;
        return false;
    }

    /// <inheritdoc/>
    internal override void OnClosed()
    {
        if (TryTransition(Committed))
        {
            result = ReceiveResult<T>.Closed;
        }
    }

    /// <summary>Resets for reuse.</summary>
    internal void Reset()
    {
        core.Reset();
        result = default;
        ResetCore();
    }

    /// <inheritdoc/>
    protected override void SetRunContinuationsAsynchronously(bool value) => core.RunContinuationsAsynchronously = value;

    /// <inheritdoc/>
    protected override void PublishResult() => core.SetResult(result);

    /// <inheritdoc/>
    protected override void PublishException(Exception exception) => core.SetException(exception);

    /// <summary>
    /// Consumes the result exactly once and returns the node to its channel's
    /// pool. Issue #3902 (S2): the node backs three <see cref="ValueTask{T}"/>
    /// shapes over one result, and only the shape the awaiter chose calls its
    /// <c>GetResult</c> — so this is still one consumption per rental. It is
    /// factored rather than repeated because the pooling predicate has to stay
    /// identical across all three; a drifted copy would return a node twice.
    /// </summary>
    /// <param name="token">The version token the awaiter holds.</param>
    /// <returns>The receive result.</returns>
    private ReceiveResult<T> TakeResult(short token)
    {
        var pool = CanPool && token == core.Version && core.GetStatus(token) != ValueTaskSourceStatus.Pending;
        try
        {
            return core.GetResult(token);
        }
        finally
        {
            if (pool)
            {
                Owner.ReturnReceiveNode(this);
            }
        }
    }
}

/// <summary>A parked sender: the awaitable behind <see cref="Chan{T}.SendAsync"/>.</summary>
/// <typeparam name="T">The channel element type.</typeparam>
internal sealed class OpSendNode<T> : ParkedNode<T>, IValueTaskSource
{
    private ManualResetValueTaskSourceCore<bool> core;
    private T? value;

    /// <summary>Initializes a new instance of the <see cref="OpSendNode{T}"/> class.</summary>
    /// <param name="owner">The channel this node parks on.</param>
    internal OpSendNode(Chan<T> owner)
        : base(owner)
    {
        core.RunContinuationsAsynchronously = true;
    }

    /// <summary>Gets the current <see cref="ValueTask"/> token; bumped on every reuse.</summary>
    internal short Version => core.Version;

    /// <inheritdoc/>
    internal override bool IsNotify => false;

    /// <inheritdoc/>
    void IValueTaskSource.GetResult(short token)
    {
        var pool = CanPool && token == core.Version && core.GetStatus(token) != ValueTaskSourceStatus.Pending;
        try
        {
            core.GetResult(token);
        }
        finally
        {
            if (pool)
            {
                Owner.ReturnSendNode(this);
            }
        }
    }

    /// <inheritdoc/>
    ValueTaskSourceStatus IValueTaskSource.GetStatus(short token) => core.GetStatus(token);

    /// <inheritdoc/>
    void IValueTaskSource.OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        => core.OnCompleted(continuation, state, token, flags);

    /// <summary>Sets the value this sender is parked with.</summary>
    /// <param name="pending">The value to hand over.</param>
    internal void SetValue(T pending) => value = pending;

    /// <inheritdoc/>
    internal override bool TryCommitReceive(T value) => false;

    /// <inheritdoc/>
    internal override bool TryCommitSend([MaybeNullWhen(false)] out T value)
    {
        if (!TryTransition(Committed))
        {
            value = default;
            return false;
        }

        // Past TryTransition(Committed), so a sender parked here has a value:
        // SetValue runs before the node is enqueued.
        value = this.value!;
        this.value = default;
        return true;
    }

    /// <inheritdoc/>
    internal override void OnClosed() => TryFault(new ChannelClosedException("send on closed channel"));

    /// <summary>Resets for reuse.</summary>
    internal void Reset()
    {
        core.Reset();
        value = default;
        ResetCore();
    }

    /// <inheritdoc/>
    protected override void SetRunContinuationsAsynchronously(bool value) => core.RunContinuationsAsynchronously = value;

    /// <inheritdoc/>
    protected override void PublishResult() => core.SetResult(true);

    /// <inheritdoc/>
    protected override void PublishException(Exception exception) => core.SetException(exception);
}

/// <summary>
/// A notification-only node behind <c>WaitToReadAsync</c>/<c>WaitToWriteAsync</c>:
/// completes with true when a transfer became possible (without consuming it)
/// and with false when the channel closed. Never pooled — it only serves BCL
/// interop callers.
/// </summary>
/// <typeparam name="T">The channel element type.</typeparam>
internal sealed class NotifyNode<T> : ParkedNode<T>, IValueTaskSource<bool>
{
    private ManualResetValueTaskSourceCore<bool> core;
    private bool result;

    /// <summary>Initializes a new instance of the <see cref="NotifyNode{T}"/> class.</summary>
    /// <param name="owner">The channel this node parks on.</param>
    internal NotifyNode(Chan<T> owner)
        : base(owner)
    {
        core.RunContinuationsAsynchronously = true;
    }

    /// <summary>Gets the <see cref="ValueTask"/> token.</summary>
    internal short Version => core.Version;

    /// <inheritdoc/>
    internal override bool IsNotify => true;

    /// <summary>
    /// Gets a value indicating whether the continuation may run inline: never,
    /// for a notifier. Its continuation is a BCL <c>WaitToReadAsync</c>
    /// consumer, and running arbitrary consumer code on a sender's stack is
    /// exactly what <c>Channel&lt;T&gt;</c> avoids by defaulting that path to
    /// asynchronous.
    /// </summary>
    protected override bool AllowsInlineCompletion => false;

    /// <inheritdoc/>
    bool IValueTaskSource<bool>.GetResult(short token) => core.GetResult(token);

    /// <inheritdoc/>
    ValueTaskSourceStatus IValueTaskSource<bool>.GetStatus(short token) => core.GetStatus(token);

    /// <inheritdoc/>
    void IValueTaskSource<bool>.OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        => core.OnCompleted(continuation, state, token, flags);

    /// <inheritdoc/>
    internal override bool TryCommitReceive(T value)
    {
        if (TryTransition(Committed))
        {
            result = true;
        }

        return false;
    }

    /// <inheritdoc/>
    internal override bool TryCommitSend([MaybeNullWhen(false)] out T value)
    {
        value = default;
        if (TryTransition(Committed))
        {
            result = true;
        }

        return false;
    }

    /// <inheritdoc/>
    internal override void OnClosed()
    {
        if (TryTransition(Committed))
        {
            result = false;
        }
    }

    /// <inheritdoc/>
    protected override void SetRunContinuationsAsynchronously(bool value) => core.RunContinuationsAsynchronously = value;

    /// <inheritdoc/>
    protected override void PublishResult() => core.SetResult(result);

    /// <inheritdoc/>
    protected override void PublishException(Exception exception) => core.SetException(exception);
}
