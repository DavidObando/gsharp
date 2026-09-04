// <copyright file="Chan{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The G#-owned channel (ADR-0174 D1): what <c>chan[T](…)</c> constructs.
/// Derives from <see cref="Channel{T}"/> so <c>chan[T]</c> stays identity-
/// transparent to the BCL type, and adds the Go-exact surface the compiler
/// emits calls to.
/// </summary>
/// <remarks>
/// <para>Semantics: capacity 0 is a rendezvous channel (a send completes only
/// when a receiver takes the value; the receive happens-before the send
/// completes); capacity <c>n</c> is a FIFO ring buffer; <see cref="Chan.Unbounded{T}"/>
/// grows without bound. <see cref="Close"/> of a closed channel throws;
/// subsequent sends throw <see cref="ChannelClosedException"/>; receives
/// drain, then yield <c>(zero, false)</c> forever. <see cref="Dispose"/> is
/// the idempotent close.</para>
/// <para>Memory model: a send that commits happens-before the receive that
/// takes its value — every transfer commits under the channel lock and is
/// published through <c>ManualResetValueTaskSourceCore</c>, so writes made
/// before a send are visible after the receive. <see cref="Length"/> is a
/// racy snapshot; <see cref="Capacity"/> is fixed for the life of the channel.</para>
/// <para>A <c>Chan&lt;T&gt;</c> never faults: <c>Writer.TryComplete(error)</c>
/// with a non-null error is rejected. Close is the only completion it has.</para>
/// </remarks>
/// <typeparam name="T">The element type.</typeparam>
public sealed partial class Chan<T> : Channel<T>, ISelectable<T>, ISendSelectableCore<T>, IDisposable
{
    private const int UnboundedInitialCapacity = 16;

    private readonly object gate = new();
    private readonly WaiterQueue<T> receivers = new();
    private readonly WaiterQueue<T> senders = new();
    private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly int capacity;
    private readonly bool isUnbounded;

    private T[]? buffer;
    private int head;
    private int count;
    private bool closed;
    private OpReceiveNode<T>? receiveNodePool;
    private OpSendNode<T>? sendNodePool;

    /// <summary>Initializes a new instance of the <see cref="Chan{T}"/> class as a rendezvous channel (capacity 0) — what <c>chan[T]()</c> constructs.</summary>
    public Chan()
        : this(0, unbounded: false)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="Chan{T}"/> class with the given buffer capacity — what <c>chan[T](n)</c> constructs.</summary>
    /// <param name="capacity">The buffer capacity; 0 is a rendezvous channel.</param>
    public Chan(int capacity)
        : this(capacity, unbounded: false)
    {
    }

    private Chan(int capacity, bool unbounded)
    {
        if (capacity < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(capacity), capacity, "Channel capacity must be non-negative.");
        }

        this.capacity = capacity;
        isUnbounded = unbounded;
        if (capacity > 0)
        {
            buffer = new T[capacity];
        }

        Id = SelectOrder.Next();
        Reader = new ChanReader(this);
        Writer = new ChanWriter(this);
    }

    /// <summary>
    /// Gets the buffer capacity. Fixed for the life of the channel and never a
    /// race; <c>Capacity == 0</c> is the documented rendezvous test.
    /// <see cref="int.MaxValue"/> for an unbounded channel.
    /// </summary>
    public int Capacity => isUnbounded ? int.MaxValue : capacity;

    /// <summary>Gets a value indicating whether this channel was created by <see cref="Chan.Unbounded{T}"/>.</summary>
    public bool IsUnbounded => isUnbounded;

    /// <summary>Gets a value indicating whether the channel has been closed (a snapshot).</summary>
    public bool IsClosed => Volatile.Read(ref closed);

    /// <summary>Gets the lock a <c>select</c> must hold to probe and register atomically (ADR-0174 D8).</summary>
    object ISelectableCore<T>.SelectGate => gate;

    /// <summary>Gets the total-order key a <c>select</c> sorts gates by before acquiring them.</summary>
    long ISelectableCore<T>.SelectOrder => Id;

    /// <summary>Gets the total order key used when a <c>select</c> locks several channels (ADR-0174 D8 step 6).</summary>
    internal long Id { get; }

    /// <summary>Gets the number of parked waiters (receivers, senders, and notifiers). Diagnostic.</summary>
    internal int RegisteredWaiterCount
    {
        get
        {
            lock (gate)
            {
                return receivers.Count + senders.Count;
            }
        }
    }

    /// <summary>
    /// Gets a value indicating whether the channel is closed with nothing left
    /// to drain — decidable without the lock. <c>closed</c> is monotonic; every
    /// enqueue happens-before the close (sends on a closed channel throw), so
    /// after acquiring <c>closed == true</c> the count can only fall, and a
    /// parked sender never contributes a value post-close (it is faulted).
    /// An observed zero therefore is a true zero. This is the lock-free
    /// closed-receive path the ADR's 382× defect turns into.
    /// </summary>
    private bool IsClosedAndDrained => Volatile.Read(ref closed) && Volatile.Read(ref count) == 0;

    /// <summary>
    /// Returns the number of buffered elements. A snapshot with no
    /// synchronization guarantee — diagnostic, not a control-flow primitive
    /// (which is why it is a method and <see cref="Capacity"/> is a property).
    /// </summary>
    /// <returns>The buffered element count at some instant.</returns>
    public int Length() => Volatile.Read(ref count);

    /// <summary>Attempts a non-blocking receive (ADR-0174 D3 three-state encoding).</summary>
    /// <param name="value">The delivered value, or the zero value.</param>
    /// <param name="ok">True when a value was delivered; false with a true return means closed and drained.</param>
    /// <returns>True when the receive completed; false when it would have to park.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TryReceive([MaybeNull] out T value, out bool ok)
    {
        if (IsClosedAndDrained)
        {
            value = default;
            ok = false;
            return true;
        }

        var completions = default(Completions);
        bool done;
        lock (gate)
        {
            done = TryReceiveLocked(out value, out ok, ref completions);
        }

        completions.Publish();
        return done;
    }

    /// <summary>Attempts a non-blocking send.</summary>
    /// <param name="value">The value to send.</param>
    /// <returns>True when the value was buffered or handed to a receiver; false when the send would have to park.</returns>
    /// <exception cref="ChannelClosedException">The channel is closed (Go: send on closed channel panics).</exception>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool TrySend(T value)
    {
        var outcome = TrySendCore(value);
        if (outcome == SendOutcome.Closed)
        {
            throw new ChannelClosedException("send on closed channel");
        }

        return outcome == SendOutcome.Sent;
    }

    /// <summary>
    /// Receives a value, parking without a thread when none is available.
    /// Cancellation wins only before the transfer commits; a committed receive
    /// returns its value even if cancellation arrives before the continuation runs.
    /// </summary>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The value and whether one was delivered (false: closed and drained).</returns>
    public ValueTask<ReceiveResult<T>> ReceiveAsync(CancellationToken cancellationToken = default)
    {
        var outcome = ReceiveOrPark(cancellationToken, out var value, out var ok, out var node);
        return outcome switch
        {
            ReceiveStart.Closed => new ValueTask<ReceiveResult<T>>(ReceiveResult<T>.Closed),
            ReceiveStart.Cancelled => ValueTask.FromCanceled<ReceiveResult<T>>(cancellationToken),
            ReceiveStart.Ready => new ValueTask<ReceiveResult<T>>(new ReceiveResult<T>(value, ok)),
            _ => new ValueTask<ReceiveResult<T>>(node!, node!.Version),
        };
    }

    /// <summary>
    /// Receives one value as the element alone — the zero value once the
    /// channel is closed and drained (ADR-0174 D3).
    /// </summary>
    /// <remarks>
    /// Issue #3902 (S2): the parked path returns a <see cref="ValueTask{T}"/>
    /// backed by the node ITSELF, so a suspending receive through the language
    /// no longer routes through an <c>async</c> wrapper that reshapes the
    /// result. That wrapper ran on the default builder and boxed an
    /// <c>AsyncStateMachineBox</c> — about 144 bytes on every park — and put a
    /// Task continuation between the node and the caller's state machine. This
    /// allocates nothing, ready or parked.
    /// </remarks>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The element, or the zero value when closed.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public ValueTask<T> ReceiveValueAsync(CancellationToken cancellationToken = default)
    {
        var outcome = ReceiveOrPark(cancellationToken, out var value, out _, out var node);
        return outcome switch
        {
            ReceiveStart.Closed => new ValueTask<T>(default(T)!),
            ReceiveStart.Cancelled => ValueTask.FromCanceled<T>(cancellationToken),
            ReceiveStart.Ready => new ValueTask<T>(value!),
            _ => new ValueTask<T>(node!, node!.Version),
        };
    }

    /// <summary>The suspending two-value receive as a tuple; see <see cref="ReceiveValueAsync"/> for why it is shaped here rather than wrapped.</summary>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The element and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public ValueTask<(T Value, bool Ok)> ReceiveTupleAsync(CancellationToken cancellationToken = default)
    {
        var outcome = ReceiveOrPark(cancellationToken, out var value, out var ok, out var node);
        return outcome switch
        {
            ReceiveStart.Closed => new ValueTask<(T Value, bool Ok)>((default(T)!, false)),
            ReceiveStart.Cancelled => ValueTask.FromCanceled<(T Value, bool Ok)>(cancellationToken),
            ReceiveStart.Ready => new ValueTask<(T Value, bool Ok)>((value!, ok)),
            _ => new ValueTask<(T Value, bool Ok)>(node!, node!.Version),
        };
    }

    /// <summary>
    /// Sends a value, parking without a thread until it is buffered or taken.
    /// On a rendezvous channel the returned task completes only after a
    /// receiver has taken the value.
    /// </summary>
    /// <param name="value">The value to send.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>A task that completes when the send commits; faults with <see cref="ChannelClosedException"/> if the channel is closed.</returns>
    public ValueTask SendAsync(T value, CancellationToken cancellationToken = default)
    {
        var completions = default(Completions);
        OpSendNode<T>? node = null;
        SendOutcome outcome;
        lock (gate)
        {
            outcome = TrySendLocked(value, ref completions);
            if (outcome == SendOutcome.Full)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    completions.Publish();
                    return ValueTask.FromCanceled(cancellationToken);
                }

                node = RentSendNode();
                node.SetValue(value);
                senders.Enqueue(node);
                node.RegisterCancellation(cancellationToken);
            }
        }

        completions.Publish();
        return outcome switch
        {
            SendOutcome.Sent => ValueTask.CompletedTask,
            SendOutcome.Closed => ValueTask.FromException(new ChannelClosedException("send on closed channel")),
            _ => new ValueTask(node!, node!.Version), // The default arm is Parked, which enqueued a node.
        };
    }

    /// <summary>Closes the channel (Go <c>close(ch)</c>). Parked receivers observe closed; parked senders fault.</summary>
    /// <exception cref="ChannelClosedException">The channel was already closed (Go: close of closed channel panics).</exception>
    public void Close()
    {
        if (!TryClose())
        {
            throw new ChannelClosedException("close of closed channel");
        }
    }

    /// <summary>Closes the channel if it is open.</summary>
    /// <returns>True when this call closed the channel; false when it was already closed.</returns>
    public bool TryClose()
    {
        var completions = default(Completions);
        lock (gate)
        {
            if (closed)
            {
                return false;
            }

            closed = true;
            while (receivers.TryDequeue(out var node))
            {
                completions.Add(node);
                node.OnClosed();
            }

            while (senders.TryDequeue(out var node))
            {
                completions.Add(node);
                node.OnClosed();
            }
        }

        completions.Publish();
        completion.TrySetResult();
        return true;
    }

    /// <summary>Closes the channel if it is not already closed. Idempotent, unlike <see cref="Close"/>, so <c>using let</c> is safe.</summary>
    public void Dispose() => TryClose();

    /// <inheritdoc/>
    bool ISelectableCore<T>.TryReceiveLocked([MaybeNull] out T value, out bool ok, ref Completions completions)
        => TryReceiveLocked(out value, out ok, ref completions);

    /// <inheritdoc/>
    void ISelectableCore<T>.RegisterReceiveLocked(SelectNode<T> node) => receivers.Enqueue(node);

    /// <inheritdoc/>
    bool ISendSelectableCore<T>.TrySendLocked(T value, ref Completions completions)
    {
        var outcome = TrySendLocked(value, ref completions);
        if (outcome == SendOutcome.Closed)
        {
            throw new ChannelClosedException("send on closed channel");
        }

        return outcome == SendOutcome.Sent;
    }

    /// <inheritdoc/>
    void ISendSelectableCore<T>.RegisterSendLocked(SelectNode<T> node) => senders.Enqueue(node);

    /// <inheritdoc/>
    void ISelectableCore<T>.Deregister(SelectNode<T> node)
    {
        lock (gate)
        {
            node.Queue?.Remove(node);
        }
    }

    /// <summary>Called by a cancellation callback: fails the node if it is still parked, otherwise a no-op (the transfer won).</summary>
    /// <param name="node">The parked node.</param>
    /// <param name="token">The cancelled token.</param>
    internal void CancelParkedNode(WaiterNode<T> node, CancellationToken token)
    {
        bool faulted;
        lock (gate)
        {
            if (!node.IsLinked)
            {
                return;
            }

            // Past the `is null` guard above: a queued node knows its queue.
            node.Queue!.Remove(node);
            faulted = node.TryCancel(new OperationCanceledException(token));
        }

        if (faulted)
        {
            node.Publish();
        }
    }

    /// <summary>Returns a consumed receive node to the single-slot pool.</summary>
    /// <param name="node">The node whose result has been consumed.</param>
    internal void ReturnReceiveNode(OpReceiveNode<T> node)
    {
        node.Reset();
        Volatile.Write(ref receiveNodePool, node);
    }

    /// <summary>Returns a consumed send node to the single-slot pool.</summary>
    /// <param name="node">The node whose result has been consumed.</param>
    internal void ReturnSendNode(OpSendNode<T> node)
    {
        node.Reset();
        Volatile.Write(ref sendNodePool, node);
    }

    /// <summary>
    /// Completes when a value is available or a sender is parked (true) or the
    /// channel is closed (false). Readiness only — another consumer may take
    /// the item first, which is why <see cref="ChannelReader{T}.WaitToReadAsync"/>
    /// callers must loop.
    /// </summary>
    /// <param name="cancellationToken">The cancellation.</param>
    /// <returns>Whether a read may succeed.</returns>
    internal ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
    {
        NotifyNode<T> node;
        lock (gate)
        {
            if (count > 0 || senders.DataCount > 0)
            {
                return new ValueTask<bool>(true);
            }

            if (closed)
            {
                return new ValueTask<bool>(false);
            }

            if (cancellationToken.IsCancellationRequested)
            {
                return ValueTask.FromCanceled<bool>(cancellationToken);
            }

            node = new NotifyNode<T>(this);
            receivers.Enqueue(node);
            node.RegisterCancellation(cancellationToken);
        }

        return new ValueTask<bool>(node, node.Version);
    }

    /// <summary>Completes when a send may succeed (true) or the channel is closed (false).</summary>
    /// <param name="cancellationToken">The cancellation.</param>
    /// <returns>Whether a write may succeed.</returns>
    internal ValueTask<bool> WaitToWriteAsync(CancellationToken cancellationToken)
    {
        NotifyNode<T> node;
        lock (gate)
        {
            if (closed)
            {
                return new ValueTask<bool>(false);
            }

            if (isUnbounded || count < capacity || receivers.DataCount > 0)
            {
                return new ValueTask<bool>(true);
            }

            if (cancellationToken.IsCancellationRequested)
            {
                return ValueTask.FromCanceled<bool>(cancellationToken);
            }

            node = new NotifyNode<T>(this);
            senders.Enqueue(node);
            node.RegisterCancellation(cancellationToken);
        }

        return new ValueTask<bool>(node, node.Version);
    }

    /// <summary>Non-throwing send used by <see cref="ChannelWriter{T}.TryWrite"/>.</summary>
    /// <param name="value">The value to send.</param>
    /// <returns>The outcome.</returns>
    internal SendOutcome TrySendCore(T value)
    {
        var completions = default(Completions);
        SendOutcome outcome;
        lock (gate)
        {
            outcome = TrySendLocked(value, ref completions);
        }

        completions.Publish();
        return outcome;
    }

    /// <summary>Creates an unbounded channel; reached only through <see cref="Chan.Unbounded{T}"/>.</summary>
    /// <returns>A new unbounded channel.</returns>
    internal static Chan<T> CreateUnbounded() => new(0, unbounded: true);

    private bool TryReceiveLocked([MaybeNull] out T value, out bool ok, ref Completions completions)
    {
        if (count > 0)
        {
            value = DequeueBuffer();

            // A parked sender means the (bounded) buffer was full: move its
            // value into the slot just freed and let it go.
            RefillFromSenderLocked(ref completions);
            ok = true;
            return true;
        }

        // Rendezvous hand-off: take directly from a parked sender. Lost select
        // nodes and notifiers decline; keep looking.
        while (senders.TryDequeue(out var node))
        {
            completions.Add(node);
            if (node.TryCommitSend(out var handed))
            {
                value = handed;
                ok = true;
                return true;
            }
        }

        value = default;
        ok = false;
        return closed;
    }

    private void RefillFromSenderLocked(ref Completions completions)
    {
        while (senders.TryDequeue(out var node))
        {
            completions.Add(node);
            if (node.TryCommitSend(out var handed))
            {
                EnqueueBuffer(handed);
                return;
            }
        }
    }

    private SendOutcome TrySendLocked(T value, ref Completions completions)
    {
        if (closed)
        {
            return SendOutcome.Closed;
        }

        // Direct hand-off to a parked receiver. Notifiers are woken (readable
        // now) but never consume; lost select nodes decline; keep looking.
        while (receivers.TryDequeue(out var node))
        {
            completions.Add(node);
            if (node.TryCommitReceive(value))
            {
                return SendOutcome.Sent;
            }
        }

        if (isUnbounded || count < capacity)
        {
            EnqueueBuffer(value);
            return SendOutcome.Sent;
        }

        return SendOutcome.Full;
    }

    private T DequeueBuffer()
    {
        var value = buffer![head];
        Array.Clear(buffer, head, 1);
        head = (head + 1) % buffer.Length;
        count--;
        return value;
    }

    private void EnqueueBuffer(T value)
    {
        if (buffer is null)
        {
            buffer = new T[UnboundedInitialCapacity];
        }
        else if (count == buffer.Length)
        {
            GrowBuffer();
        }

        buffer[(head + count) % buffer.Length] = value;
        count++;
    }

    private void GrowBuffer()
    {
        // Only reached for a buffered channel; a rendezvous has no buffer to grow.
        var grown = new T[buffer!.Length * 2];
        for (var i = 0; i < count; i++)
        {
            grown[i] = buffer[(head + i) % buffer.Length];
        }

        buffer = grown;
        head = 0;
    }

    /// <summary>
    /// The shared start of every suspending receive: take a ready value, or
    /// park a node. Factored so the three result shapes (issue #3902 S2) differ
    /// only in how they wrap the outcome — the lock body, the cancellation
    /// check and the completion publication have one copy between them.
    /// </summary>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <param name="value">The value taken, when the outcome is <see cref="ReceiveStart.Ready"/>.</param>
    /// <param name="ok">Whether a value was delivered, when ready.</param>
    /// <param name="node">The parked node, when the outcome is <see cref="ReceiveStart.Parked"/>.</param>
    /// <returns>How the receive started.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private ReceiveStart ReceiveOrPark(
        CancellationToken cancellationToken,
        out T? value,
        out bool ok,
        out OpReceiveNode<T>? node)
    {
        value = default;
        ok = false;
        node = null;
        if (IsClosedAndDrained)
        {
            return ReceiveStart.Closed;
        }

        var completions = default(Completions);
        bool done;
        lock (gate)
        {
            done = TryReceiveLocked(out value, out ok, ref completions);
            if (!done)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    completions.Publish();
                    return ReceiveStart.Cancelled;
                }

                node = RentReceiveNode();
                receivers.Enqueue(node);
                node.RegisterCancellation(cancellationToken);
            }
        }

        completions.Publish();
        return done ? ReceiveStart.Ready : ReceiveStart.Parked;
    }

    private OpReceiveNode<T> RentReceiveNode()
        => Interlocked.Exchange(ref receiveNodePool, null) ?? new OpReceiveNode<T>(this);

    private OpSendNode<T> RentSendNode()
        => Interlocked.Exchange(ref sendNodePool, null) ?? new OpSendNode<T>(this);
}
