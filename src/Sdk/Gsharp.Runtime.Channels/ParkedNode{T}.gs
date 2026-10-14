// <copyright file="ParkedNode{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks.Sources

/// Shared state machine of a single-operation parked node: a CAS-guarded
/// `Pending → Committed | Faulted` transition, an optional cancellation
/// registration, and deferred publication. The claim (state transition plus
/// value deposit) happens under the channel lock; publication happens after.
/// @typeparam T The channel element type.
internal abstract class ParkedNode[T] : WaiterNode[T] {
    private let owner Chan[T]
    private var state int32
    private var fault Exception?
    private var registration CancellationTokenRegistration
    private var hasRegistration bool
    private var published bool

    /// Initializes a new instance of the (cref:ParkedNode{T}) class.
    /// @param owner The channel this node parks on.
    protected init(owner Chan[T]) {
        this.owner = owner
    }

    /// Gets a value indicating whether the node may be returned to its pool
    /// after its result is consumed: false when a cancellation callback may
    /// still be in flight against it (a stale callback must never see a
    /// reused node — the ABA hazard ADR-0174 D8 names for pooled waiters).
    private var _canPool bool = true

    internal prop CanPool bool {
        get {
            return _canPool
        }
        private set {
            _canPool = value
        }
    }

    /// Gets the channel this node parks on.
    protected prop Owner Chan[T] -> owner

    /// Gets a value indicating whether a transfer committed to this node.
    protected prop IsCommitted bool -> Volatile.Read(&state) == Committed

    /// Gets a value indicating whether this node's continuation may run on the
    /// publishing thread (issue #3902 H1). False for notifiers: their
    /// continuation is a BCL `WaitToReadAsync` consumer, which
    /// (cref:System.Threading.Channels.Channel{T}) itself completes
    /// asynchronously for the same reason.
    protected open prop AllowsInlineCompletion bool -> true

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCancel(exception OperationCanceledException) bool -> TryFault(exception)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func Publish() {
        if published {
            return
        }
        published = true
        if hasRegistration {
            // Unregister returns false when the callback already ran or is
            // running; either way the node must not be reused.
            CanPool = registration.Unregister()
        }
        // Issue #3902 H1 / ADR-0174 gate G6: complete the awaiter's
        // continuation on this thread when the budget allows, instead of
        // queueing a thread-pool work item and waiting for another thread to
        // steal it. Publication already happens outside every channel lock,
        // which is what makes this admissible at all.
        let inline = AllowsInlineCompletion && InlineBudget.TryEnter()
        try {
            SetRunContinuationsAsynchronously(!inline)
            if Volatile.Read(&state) == Committed {
                PublishResult()
            } else {
                PublishException(fault!!)
            }
        } finally {
            if inline {
                InlineBudget.Exit()
            }
        }
    }

    /// Registers cancellation. Called under the channel lock after the node is
    /// linked, so a token that is already cancelled runs the callback inline
    /// (re-entering the lock) and faults the node before the caller returns it.
    /// @param token The token to observe.
    internal func RegisterCancellation(token CancellationToken) {
        if !token.CanBeCanceled {
            return
        }
        hasRegistration = true
        registration = token.UnsafeRegister(
            (state object?, token CancellationToken) -> {
                // The state is `this`, handed to UnsafeRegister just below.
                let node = cast[ParkedNode[T]](state!!)
                node.owner.CancelParkedNode(node, token)
            },
            this
        )
    }

    /// Attempts the `Pending → target` transition.
    /// @param target The target state.
    /// @returns True when this call performed the transition.
    protected func TryTransition(target int32) bool -> Interlocked.CompareExchange(&state, target, Pending) == Pending

    /// Attempts to fault the node.
    /// @param exception The fault.
    /// @returns True when this call faulted the node.
    protected func TryFault(exception Exception) bool {
        if !TryTransition(Faulted) {
            return false
        }
        fault = exception
        return true
    }

    /// Points the node's value-task source at inline or queued completion.
    /// @param value Whether continuations must be queued.
    protected open func SetRunContinuationsAsynchronously(value bool);

    /// Publishes the committed result to the awaiter.
    protected open func PublishResult();

    /// Publishes a fault to the awaiter.
    /// @param exception The fault.
    protected open func PublishException(exception Exception);

    /// Resets the shared state for pooling.
    protected func ResetCore() {
        state = Pending
        fault = nil
        registration = default(CancellationTokenRegistration)
        hasRegistration = false
        published = false
        CanPool = true
    }

    shared {
        /// The node is parked and may still be claimed, cancelled, or closed.
        protected const Pending int32 = 0

        /// A transfer (or a close) committed to this node.
        protected const Committed int32 = 1

        /// The node was cancelled or the channel closed on a sender.
        protected const Faulted int32 = 2
    }
}

/// A parked receiver: the awaitable behind (cref:Chan{T}.ReceiveAsync).
/// @typeparam T The channel element type.
internal class OpReceiveNode[T] : ParkedNode[T],
IValueTaskSource[ReceiveResult[T]],
IValueTaskSource[T],
IValueTaskSource[(Value T, Ok bool)] {
    private var core ManualResetValueTaskSourceCore[ReceiveResult[T]]
    private var result ReceiveResult[T]

    /// Initializes a new instance of the (cref:OpReceiveNode{T}) class.
    /// @param owner The channel this node parks on.
    internal init(owner Chan[T]) : base(owner) {
        this.core.RunContinuationsAsynchronously = true
    }

    /// Gets the current (cref:ValueTask) token; bumped on every reuse.
    internal prop Version int16 -> core.Version

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop IsNotify bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[ReceiveResult[T]]) GetResult(token int16) ReceiveResult[T] -> TakeResult(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[ReceiveResult[T]]) GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(
        token
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[ReceiveResult[T]]) OnCompleted(
        continuation(object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags
    ) -> core.OnCompleted(continuation, state, token, flags)

    // The single-value shape. A closed, drained channel yields the zero value
    // by design (ADR-0174 D3), so there is no null to guard.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[T]) GetResult(token int16) T -> TakeResult(token).Element

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[T]) GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[T]) OnCompleted(
        continuation(object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags
    ) -> core.OnCompleted(continuation, state, token, flags)

    // The two-value shape: the tuple IS the three-state encoding (D3).
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[(Value T, Ok bool)]) GetResult(token int16)(Value T, Ok bool) {
        let taken = TakeResult(token)
        return (taken.Element, taken.Ok)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[(Value T, Ok bool)]) GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(
        token
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[(Value T, Ok bool)]) OnCompleted(
        continuation(object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags
    ) -> core.OnCompleted(continuation, state, token, flags)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitReceive(value T) bool {
        if !TryTransition(ParkedNode[T].Committed) {
            return false
        }
        result = ReceiveResult[T](value, true)
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitSend(@MaybeNullWhen(false) out value T) bool {
        value = default(T)
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func OnClosed() {
        if TryTransition(ParkedNode[T].Committed) {
            result = ReceiveResult[T].Closed
        }
    }

    /// Resets for reuse.
    internal func Reset() {
        core.Reset()
        result = default(ReceiveResult[T])
        ResetCore()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func SetRunContinuationsAsynchronously(value bool) -> this
        .core
        .RunContinuationsAsynchronously = value

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func PublishResult() -> core.SetResult(result)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func PublishException(exception Exception) -> core.SetException(exception)

    /// Consumes the result exactly once and returns the node to its channel's
    /// pool. Issue #3902 (S2): the node backs three (cref:ValueTask{T})
    /// shapes over one result, and only the shape the awaiter chose calls its
    /// `GetResult` — so this is still one consumption per rental. It is
    /// factored rather than repeated because the pooling predicate has to stay
    /// identical across all three; a drifted copy would return a node twice.
    /// @param token The version token the awaiter holds.
    /// @returns The receive result.
    private func TakeResult(token int16) ReceiveResult[T] {
        let pool = CanPool && token == core.Version && core.GetStatus(token) != ValueTaskSourceStatus.Pending
        try {
            return core.GetResult(token)
        } finally {
            if pool {
                Owner.ReturnReceiveNode(this)
            }
        }
    }
}

/// A parked sender: the awaitable behind (cref:Chan{T}.SendAsync).
/// @typeparam T The channel element type.
internal class OpSendNode[T] : ParkedNode[T], IValueTaskSource {
    private var core ManualResetValueTaskSourceCore[bool]

    @AllowNull
    private var value T

    /// Initializes a new instance of the (cref:OpSendNode{T}) class.
    /// @param owner The channel this node parks on.
    internal init(owner Chan[T]) : base(owner) {
        this.core.RunContinuationsAsynchronously = true
    }

    /// Gets the current (cref:ValueTask) token; bumped on every reuse.
    internal prop Version int16 -> core.Version

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop IsNotify bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource) GetResult(token int16) {
        let pool = CanPool && token == core.Version && core.GetStatus(token) != ValueTaskSourceStatus.Pending
        try {
            core.GetResult(token)
        } finally {
            if pool {
                Owner.ReturnSendNode(this)
            }
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource) GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource) OnCompleted(
        continuation(object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags
    ) -> core.OnCompleted(continuation, state, token, flags)

    /// Sets the value this sender is parked with.
    /// @param pending The value to hand over.
    internal func SetValue(pending T) -> value = pending

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitReceive(value T) bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitSend(@MaybeNullWhen(false) out value T) bool {
        if !TryTransition(ParkedNode[T].Committed) {
            value = default(T)
            return false
        }
        // Past TryTransition(Committed), so a sender parked here has a value:
        // SetValue runs before the node is enqueued.
        value = this.value
        this.value = default(T)
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func OnClosed() -> TryFault(ChannelClosedException("send on closed channel"))

    /// Resets for reuse.
    internal func Reset() {
        core.Reset()
        value = default(T)
        ResetCore()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func SetRunContinuationsAsynchronously(value bool) -> this
        .core
        .RunContinuationsAsynchronously = value

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func PublishResult() -> core.SetResult(true)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func PublishException(exception Exception) -> core.SetException(exception)
}

/// A notification-only node behind `WaitToReadAsync`/`WaitToWriteAsync`:
/// completes with true when a transfer became possible (without consuming it)
/// and with false when the channel closed. Never pooled — it only serves BCL
/// interop callers.
/// @typeparam T The channel element type.
internal class NotifyNode[T] : ParkedNode[T], IValueTaskSource[bool] {
    private var core ManualResetValueTaskSourceCore[bool]
    private var result bool

    /// Initializes a new instance of the (cref:NotifyNode{T}) class.
    /// @param owner The channel this node parks on.
    internal init(owner Chan[T]) : base(owner) {
        this.core.RunContinuationsAsynchronously = true
    }

    /// Gets the (cref:ValueTask) token.
    internal prop Version int16 -> core.Version

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override prop IsNotify bool -> true

    /// Gets a value indicating whether the continuation may run inline: never,
    /// for a notifier. Its continuation is a BCL `WaitToReadAsync`
    /// consumer, and running arbitrary consumer code on a sender's stack is
    /// exactly what `Channel<T>` avoids by defaulting that path to
    /// asynchronous.
    protected override prop AllowsInlineCompletion bool -> false

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[bool]) GetResult(token int16) bool -> core.GetResult(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[bool]) GetStatus(token int16) ValueTaskSourceStatus -> core.GetStatus(token)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IValueTaskSource[bool]) OnCompleted(
        continuation(object?) -> void,
        state object?,
        token int16,
        flags ValueTaskSourceOnCompletedFlags
    ) -> core.OnCompleted(continuation, state, token, flags)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitReceive(value T) bool {
        if TryTransition(ParkedNode[T].Committed) {
            result = true
        }
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func TryCommitSend(@MaybeNullWhen(false) out value T) bool {
        value = default(T)
        if TryTransition(ParkedNode[T].Committed) {
            result = true
        }
        return false
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    internal override func OnClosed() {
        if TryTransition(ParkedNode[T].Committed) {
            result = false
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func SetRunContinuationsAsynchronously(value bool) -> this
        .core
        .RunContinuationsAsynchronously = value

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func PublishResult() -> core.SetResult(result)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func PublishException(exception Exception) -> core.SetException(exception)
}
