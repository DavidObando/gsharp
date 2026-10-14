// <copyright file="Chan{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks
import SystemObject = System.Object

/// The G#-owned channel (ADR-0174 D1): what `chan[T](…)` constructs.
/// Derives from (cref:Channel{T}) so `chan[T]` stays identity-
/// transparent to the BCL type, and adds the Go-exact surface the compiler
/// emits calls to.
/// @remarks Semantics: capacity 0 is a rendezvous channel (a send completes only
/// when a receiver takes the value; the receive happens-before the send
/// completes); capacity `n` is a FIFO ring buffer; (cref:Chan.Unbounded{T})
/// grows without bound. (cref:Close) of a closed channel throws;
/// subsequent sends throw (cref:ChannelClosedException); receives
/// drain, then yield `(zero, false)` forever. (cref:Dispose) is
/// the idempotent close.
///
/// Memory model: a send that commits happens-before the receive that
/// takes its value — every transfer commits under the channel lock and is
/// published through `ManualResetValueTaskSourceCore`, so writes made
/// before a send are visible after the receive. (cref:Length) is a
/// racy snapshot; (cref:Capacity) is fixed for the life of the channel.
///
/// A `Chan<T>` never faults: `Writer.TryComplete(error)`
/// with a non-null error is rejected. Close is the only completion it has.
/// @typeparam T The element type.
partial class Chan[T] : Channel[T], ISelectable[T], ISendSelectableCore[T], IDisposable {
    private let gate object = SystemObject()
    private let receivers WaiterQueue[T] = WaiterQueue[T]()
    private let senders WaiterQueue[T] = WaiterQueue[T]()
    private let completion TaskCompletionSource = TaskCompletionSource(
        TaskCreationOptions.RunContinuationsAsynchronously
    )
    private let capacity int32
    private let isUnbounded bool
    private var buffer[]?T
    private var head int32
    private var count int32
    private var closed bool
    private var receiveNodePool OpReceiveNode[T]?
    private var sendNodePool OpSendNode[T]?

    /// Initializes a new instance of the (cref:Chan{T}) class as a rendezvous channel (capacity 0) — what
    /// `chan[T]()` constructs.
    convenience init() {
        init(0, false)
    }

    /// Initializes a new instance of the (cref:Chan{T}) class with the given buffer capacity — what
    /// `chan[T](n)` constructs.
    /// @param capacity The buffer capacity; 0 is a rendezvous channel.
    convenience init(capacity int32) {
        init(capacity, false)
    }

    private init(capacity int32, unbounded bool) {
        if capacity < 0 {
            throw ArgumentOutOfRangeException("capacity", capacity, "Channel capacity must be non-negative.")
        }
        this.capacity = capacity
        isUnbounded = unbounded
        if capacity > 0 {
            buffer = [capacity]T
        }
        Id = SelectOrder.Next()
        Reader = ChanReader(this)
        Writer = ChanWriter(this)
    }

    /// Gets the buffer capacity. Fixed for the life of the channel and never a
    /// race; `Capacity == 0` is the documented rendezvous test.
    /// (cref:int.MaxValue) for an unbounded channel.
    prop Capacity int32 -> if isUnbounded {
        int32.MaxValue
    } else {
        capacity
    }

    /// Gets a value indicating whether this channel was created by (cref:Chan.Unbounded{T}).
    prop IsUnbounded bool -> isUnbounded

    /// Gets a value indicating whether the channel has been closed (a snapshot).
    prop IsClosed bool -> Volatile.Read(&closed)

    /// Gets the lock a `select` must hold to probe and register atomically (ADR-0174 D8).
    private prop(ISelectableCore[T]) SelectGate object -> gate

    /// Gets the total-order key a `select` sorts gates by before acquiring them.
    private prop(ISelectableCore[T]) SelectOrder int64 -> Id

    /// Gets the total order key used when a `select` locks several channels (ADR-0174 D8 step 6).
    internal prop Id int64 {
        get;
    }

    /// Gets the number of parked waiters (receivers, senders, and notifiers). Diagnostic.
    internal prop RegisteredWaiterCount int32 {
        get {
            lock gate {
                return receivers.Count + senders.Count
            }
        }
    }

    /// Gets a value indicating whether the channel is closed with nothing left
    /// to drain — decidable without the lock. `closed` is monotonic; every
    /// enqueue happens-before the close (sends on a closed channel throw), so
    /// after acquiring `closed == true` the count can only fall, and a
    /// parked sender never contributes a value post-close (it is faulted).
    /// An observed zero therefore is a true zero. This is the lock-free
    /// closed-receive path the ADR's 382× defect turns into.
    private prop IsClosedAndDrained bool -> Volatile.Read(&closed) && Volatile.Read(&count) == 0

    /// Returns the number of buffered elements. A snapshot with no
    /// synchronization guarantee — diagnostic, not a control-flow primitive
    /// (which is why it is a method and (cref:Capacity) is a property).
    /// @returns The buffered element count at some instant.
    func Length() int32 -> Volatile.Read(&count)

    /// Attempts a non-blocking receive (ADR-0174 D3 three-state encoding).
    /// @param value The delivered value, or the zero value.
    /// @param ok True when a value was delivered; false with a true return means closed and drained.
    /// @returns True when the receive completed; false when it would have to park.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func TryReceive(@MaybeNull out value T, out ok bool) bool {
        if IsClosedAndDrained {
            value = default(T)
            ok = false
            return true
        }
        var completions = default(Completions)
        var done bool
        lock gate {
            done = TryReceiveLocked(out value, out ok, &completions)
        }
        completions.Publish()
        return done
    }

    /// Attempts a non-blocking send.
    /// @param value The value to send.
    /// @returns True when the value was buffered or handed to a receiver; false when the send would have to
    /// park.
    /// @exception ChannelClosedException The channel is closed (Go: send on closed channel panics).
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func TrySend(value T) bool {
        let outcome = TrySendCore(value)
        if outcome == SendOutcome.Closed {
            throw ChannelClosedException("send on closed channel")
        }
        return outcome == SendOutcome.Sent
    }

    /// Receives a value, parking without a thread when none is available.
    /// Cancellation wins only before the transfer commits; a committed receive
    /// returns its value even if cancellation arrives before the continuation runs.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The value and whether one was delivered (false: closed and drained).
    func ReceiveAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[ReceiveResult[T]] {
        let outcome = ReceiveOrPark(cancellationToken, out var value, out var ok, out var node)
        return switch outcome {
            case ReceiveStart.Closed: ValueTask[ReceiveResult[T]](ReceiveResult[T].Closed)
            case ReceiveStart.Cancelled: ValueTask.FromCanceled[ReceiveResult[T]](cancellationToken)
            case ReceiveStart.Ready: ValueTask[ReceiveResult[T]](ReceiveResult[T](value, ok))
            default: ValueTask[ReceiveResult[T]](node!!, node!!.Version)
        }
    }

    /// Receives one value as the element alone — the zero value once the
    /// channel is closed and drained (ADR-0174 D3).
    /// @remarks Issue #3902 (S2): the parked path returns a (cref:ValueTask{T})
    /// backed by the node ITSELF, so a suspending receive through the language
    /// no longer routes through an `async` wrapper that reshapes the
    /// result. That wrapper ran on the default builder and boxed an
    /// `AsyncStateMachineBox` — about 144 bytes on every park — and put a
    /// Task continuation between the node and the caller's state machine. This
    /// allocates nothing, ready or parked.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The element, or the zero value when closed.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveValueAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[T] {
        let outcome = ReceiveOrPark(cancellationToken, out var value, out var ok, out var node)
        let delivered = ReceiveResult[T](value, ok)
        return switch outcome {
            case ReceiveStart.Closed: default(ValueTask[T])
            case ReceiveStart.Cancelled: ValueTask.FromCanceled[T](cancellationToken)
            case ReceiveStart.Ready: ValueTask[T](delivered.Element)
            default: ValueTask[T](node!!, node!!.Version)
        }
    }

    /// The suspending two-value receive as a tuple; see (cref:ReceiveValueAsync) for why it is shaped here
    /// rather than wrapped.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The element and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveTupleAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[
        (Value T, Ok bool)
    ] {
        let outcome = ReceiveOrPark(cancellationToken, out var value, out var ok, out var node)
        let delivered = ReceiveResult[T](value, ok)
        return switch outcome {
            case ReceiveStart.Closed: default(ValueTask[(Value T, Ok bool)])
            case ReceiveStart.Cancelled: ValueTask.FromCanceled[(Value T, Ok bool)](cancellationToken)
            case ReceiveStart.Ready: ValueTask[(Value T, Ok bool)]((delivered.Element, ok))
            default: ValueTask[(Value T, Ok bool)](node!!, node!!.Version)
        }
    }

    /// Sends a value, parking without a thread until it is buffered or taken.
    /// On a rendezvous channel the returned task completes only after a
    /// receiver has taken the value.
    /// @param value The value to send.
    /// @param cancellationToken The ambient cancellation.
    /// @returns A task that completes when the send commits; faults with (cref:ChannelClosedException) if
    /// the channel is closed.
    func SendAsync(value T, cancellationToken CancellationToken = default(CancellationToken)) ValueTask {
        var completions = default(Completions)
        var node OpSendNode[T]? = nil
        var outcome SendOutcome
        lock gate {
            outcome = TrySendLocked(value, &completions)
            if outcome == SendOutcome.Full {
                if cancellationToken.IsCancellationRequested {
                    completions.Publish()
                    return ValueTask.FromCanceled(cancellationToken)
                }
                node = RentSendNode()
                node.SetValue(value)
                senders.Enqueue(node)
                node.RegisterCancellation(cancellationToken)
            }
        }
        completions.Publish()
        return switch outcome {
            case SendOutcome.Sent: ValueTask.CompletedTask
            case SendOutcome.Closed: ValueTask.FromException(ChannelClosedException("send on closed channel"))
            default: ValueTask(node!!, node!!.Version)
        }
    }

    /// Closes the channel (Go `close(ch)`). Parked receivers observe closed; parked senders fault.
    /// @exception ChannelClosedException The channel was already closed (Go: close of closed channel
    /// panics).
    func Close() {
        if !TryClose() {
            throw ChannelClosedException("close of closed channel")
        }
    }

    /// Closes the channel if it is open.
    /// @returns True when this call closed the channel; false when it was already closed.
    func TryClose() bool {
        var completions = default(Completions)
        lock gate {
            if closed {
                return false
            }
            closed = true
            while receivers.TryDequeue(out var node) {
                completions.Add(node!!)
                node!!.OnClosed()
            }
            while senders.TryDequeue(out var node) {
                completions.Add(node!!)
                node!!.OnClosed()
            }
        }
        completions.Publish()
        completion.TrySetResult()
        return true
    }

    /// Closes the channel if it is not already closed. Idempotent, unlike (cref:Close), so `using let` is
    /// safe.
    func Dispose() -> TryClose()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[T]) TryReceiveLocked(
        @MaybeNull out value T,
        out ok bool,
        ref completions Completions
    ) bool -> TryReceiveLocked(out value, out ok, &completions)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[T]) RegisterReceiveLocked(node SelectNode[T]) -> receivers.Enqueue(node)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISendSelectableCore[T]) TrySendLocked(value T, ref completions Completions) bool {
        let outcome = TrySendLocked(value, &completions)
        if outcome == SendOutcome.Closed {
            throw ChannelClosedException("send on closed channel")
        }
        return outcome == SendOutcome.Sent
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISendSelectableCore[T]) RegisterSendLocked(node SelectNode[T]) -> senders.Enqueue(node)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (ISelectableCore[T]) Deregister(node SelectNode[T]) {
        lock gate {
            node.Queue?.Remove(node)
        }
    }

    /// Called by a cancellation callback: fails the node if it is still parked, otherwise a no-op (the
    /// transfer won).
    /// @param node The parked node.
    /// @param token The cancelled token.
    internal func CancelParkedNode(node WaiterNode[T], token CancellationToken) {
        var faulted bool
        lock gate {
            if !node.IsLinked {
                return
            }
            // Past the `is null` guard above: a queued node knows its queue.
            node.Queue!!.Remove(node)
            faulted = node.TryCancel(OperationCanceledException(token))
        }
        if faulted {
            node.Publish()
        }
    }

    /// Returns a consumed receive node to the single-slot pool.
    /// @param node The node whose result has been consumed.
    internal func ReturnReceiveNode(node OpReceiveNode[T]) {
        node.Reset()
        Volatile.Write(&receiveNodePool, node)
    }

    /// Returns a consumed send node to the single-slot pool.
    /// @param node The node whose result has been consumed.
    internal func ReturnSendNode(node OpSendNode[T]) {
        node.Reset()
        Volatile.Write(&sendNodePool, node)
    }

    /// Completes when a value is available or a sender is parked (true) or the
    /// channel is closed (false). Readiness only — another consumer may take
    /// the item first, which is why (cref:ChannelReader{T}.WaitToReadAsync)
    /// callers must loop.
    /// @param cancellationToken The cancellation.
    /// @returns Whether a read may succeed.
    internal func WaitToReadAsync(cancellationToken CancellationToken) ValueTask[bool] {
        var node NotifyNode[T]
        lock gate {
            if count > 0 || senders.DataCount > 0 {
                return ValueTask[bool](true)
            }
            if closed {
                return ValueTask[bool](false)
            }
            if cancellationToken.IsCancellationRequested {
                return ValueTask.FromCanceled[bool](cancellationToken)
            }
            node = NotifyNode[T](this)
            receivers.Enqueue(node)
            node.RegisterCancellation(cancellationToken)
        }
        return ValueTask[bool](node, node.Version)
    }

    /// Completes when a send may succeed (true) or the channel is closed (false).
    /// @param cancellationToken The cancellation.
    /// @returns Whether a write may succeed.
    internal func WaitToWriteAsync(cancellationToken CancellationToken) ValueTask[bool] {
        var node NotifyNode[T]
        lock gate {
            if closed {
                return ValueTask[bool](false)
            }
            if isUnbounded || count < capacity || receivers.DataCount > 0 {
                return ValueTask[bool](true)
            }
            if cancellationToken.IsCancellationRequested {
                return ValueTask.FromCanceled[bool](cancellationToken)
            }
            node = NotifyNode[T](this)
            senders.Enqueue(node)
            node.RegisterCancellation(cancellationToken)
        }
        return ValueTask[bool](node, node.Version)
    }

    /// Non-throwing send used by (cref:ChannelWriter{T}.TryWrite).
    /// @param value The value to send.
    /// @returns The outcome.
    internal func TrySendCore(value T) SendOutcome {
        var completions = default(Completions)
        var outcome SendOutcome
        lock gate {
            outcome = TrySendLocked(value, &completions)
        }
        completions.Publish()
        return outcome
    }

    private func TryReceiveLocked(@MaybeNull out value T, out ok bool, ref completions Completions) bool {
        if count > 0 {
            value = DequeueBuffer()
            // A parked sender means the (bounded) buffer was full: move its
            // value into the slot just freed and let it go.
            RefillFromSenderLocked(&completions)
            ok = true
            return true
        }
        // Rendezvous hand-off: take directly from a parked sender. Lost select
        // nodes and notifiers decline; keep looking.
        while senders.TryDequeue(out var node) {
            completions.Add(node!!)
            if node!!.TryCommitSend(out var handed) {
                value = handed
                ok = true
                return true
            }
        }
        value = default(T)
        ok = false
        return closed
    }

    /// Copies as much of the ring as fits into [`destination`](paramref),
    /// in at most two contiguous spans (issue #3902 S3).
    /// @remarks The batch receive used to walk `DequeueBuffer` per element, paying a
    /// modulo and an `Array.Clear` of one slot each time. The clear only
    /// matters when `T` can hold a reference — leaving a
    /// dead reference in the ring keeps an object alive — so for a blittable
    /// element it is skipped entirely.
    /// @param destination Where to copy.
    /// @returns The number of elements copied.
    private func DrainBufferInto(destination Span[T]) int32 {
        let ring[]?T = buffer
        if ring == nil || count == 0 || destination.IsEmpty {
            return 0
        }
        let take = Math.Min(destination.Length, count)
        let first = Math.Min(take, ring.Length - head)
        ring.AsSpan(head, first).CopyTo(destination)
        if take > first {
            ring.AsSpan(0, take - first).CopyTo(destination[first ..])
        }
        if RuntimeHelpers.IsReferenceOrContainsReferences[T]() {
            Array.Clear(ring, head, first)
            if take > first {
                Array.Clear(ring, 0, take - first)
            }
        }
        head = (head + take) % ring.Length
        count -= take
        return take
    }

    private func RefillFromSenderLocked(ref completions Completions) {
        while senders.TryDequeue(out var node) {
            completions.Add(node!!)
            if node!!.TryCommitSend(out var handed) {
                EnqueueBuffer(handed)
                return
            }
        }
    }

    private func TrySendLocked(value T, ref completions Completions) SendOutcome {
        if closed {
            return SendOutcome.Closed
        }
        // Direct hand-off to a parked receiver. Notifiers are woken (readable
        // now) but never consume; lost select nodes decline; keep looking.
        while receivers.TryDequeue(out var node) {
            completions.Add(node!!)
            if node!!.TryCommitReceive(value) {
                return SendOutcome.Sent
            }
        }
        if isUnbounded || count < capacity {
            EnqueueBuffer(value)
            return SendOutcome.Sent
        }
        return SendOutcome.Full
    }

    private func DequeueBuffer() T {
        let value = buffer!![head]
        Array.Clear(buffer!!, head, 1)
        head = (head + 1) % buffer!!.Length
        count--
        return value
    }

    private func EnqueueBuffer(value T) {
        if buffer == nil {
            buffer = [UnboundedInitialCapacity]T
        } else if count == buffer!!.Length {
            GrowBuffer()
        }
        buffer!![(head + count) % buffer!!.Length] = value
        count++
    }

    private func GrowBuffer() {
        // Only reached for a buffered channel; a rendezvous has no buffer to grow.
        let grown = [buffer!!.Length * 2]T
        for var i = 0; i < count; i++ {
            grown[i] = buffer!![(head + i) % buffer!!.Length]
        }
        buffer = grown
        head = 0
    }

    /// The shared start of every suspending receive: take a ready value, or
    /// park a node. Factored so the three result shapes (issue #3902 S2) differ
    /// only in how they wrap the outcome — the lock body, the cancellation
    /// check and the completion publication have one copy between them.
    /// @param cancellationToken The ambient cancellation.
    /// @param value The value taken, when the outcome is (cref:ReceiveStart.Ready).
    /// @param ok Whether a value was delivered, when ready.
    /// @param node The parked node, when the outcome is (cref:ReceiveStart.Parked).
    /// @returns How the receive started.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    private func ReceiveOrPark(
        cancellationToken CancellationToken,
        @MaybeNull out value T,
        out ok bool,
        out node OpReceiveNode[T]?
    ) ReceiveStart {
        value = default(T)
        ok = false
        node = nil
        if IsClosedAndDrained {
            return ReceiveStart.Closed
        }
        var completions = default(Completions)
        var done bool
        lock gate {
            done = TryReceiveLocked(out value, out ok, &completions)
            if !done {
                if cancellationToken.IsCancellationRequested {
                    completions.Publish()
                    return ReceiveStart.Cancelled
                }
                node = RentReceiveNode()
                receivers.Enqueue(node!!)
                node!!.RegisterCancellation(cancellationToken)
            }
        }
        completions.Publish()
        return if done {
            ReceiveStart.Ready
        } else {
            ReceiveStart.Parked
        }
    }

    private func RentReceiveNode() OpReceiveNode[T] -> Interlocked.Exchange(&receiveNodePool, nil) ??
        OpReceiveNode[T](this)

    private func RentSendNode() OpSendNode[T] -> Interlocked.Exchange(&sendNodePool, nil) ?? OpSendNode[T](this)

    shared {
        private const UnboundedInitialCapacity int32 = 16

        /// Creates an unbounded channel; reached only through (cref:Chan.Unbounded{T}).
        /// @returns A new unbounded channel.
        internal func CreateUnbounded() Chan[T] -> Chan[T](0, unbounded: true)
    }
}
