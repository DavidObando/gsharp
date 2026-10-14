// <copyright file="Chan{T}.Batch.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// ```xmldoc
/// <content>Bulk transfer (ADR-0174 D10): "share <em>buffers</em> by communicating".</content>
/// ```
partial class Chan[T] : Channel[T], ISelectable[T], ISendSelectableCore[T], IDisposable {
    /// Takes as many buffered (or parked-sender) elements as fit, without
    /// parking. One lock acquisition for the whole batch. Returns 0 when
    /// nothing is available <em>or</em> the channel is closed and drained —
    /// check (cref:IsClosed) to tell them apart.
    /// @param buffer The destination; a (cref:Span{T}) is legal because this never crosses a suspension
    /// point.
    /// @returns The number of elements written.
    func TryReceiveBatch(buffer Span[T]) int32 {
        if buffer.IsEmpty {
            return 0
        }
        var completions = default(Completions)
        var taken int32
        lock gate {
            taken = TryReceiveBatchLocked(buffer, &completions)
        }
        completions.Publish()
        return taken
    }

    /// Sends as many elements as parked receivers and buffer room will take,
    /// without parking. One lock acquisition for the whole batch.
    /// @param items The elements to offer.
    /// @returns The number of elements transferred.
    /// @exception ChannelClosedException The channel is closed.
    func TrySendBatch(items ReadOnlySpan[T]) int32 {
        if items.IsEmpty {
            return 0
        }
        var completions = default(Completions)
        var sent int32
        lock gate {
            if closed {
                throw ChannelClosedException("send on closed channel")
            }
            sent = TrySendBatchLocked(items, &completions)
        }
        completions.Publish()
        return sent
    }

    /// Receives at least [`atLeast`](paramref) elements (and up to
    /// [`buffer`](paramref)'s length), parking without a thread while
    /// fewer are available. `atLeast = 1` is Go's `range`-like
    /// "take what is there"; `atLeast = buffer.Length` is a full-fill
    /// barrier. A (cref:Memory{T}) because the destination must
    /// survive a suspension.
    /// @param buffer The destination.
    /// @param atLeast The minimum count to wait for, clamped to `[1, buffer.Length]`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The count transferred: at least [`atLeast`](paramref) normally;
    /// fewer (possibly 0) when the channel closed mid-batch — the next call
    /// reports closed; and the count so far when cancellation arrives after at
    /// least one element moved (ADR-0174 D7's linearization rule — never a bare
    /// throw that hides the count and invites duplicates on retry).
    /// @exception OperationCanceledException Cancelled before any element was transferred.
    func ReceiveBatchAsync(
        buffer Memory[T],
        atLeast int32,
        cancellationToken CancellationToken = default(CancellationToken)
    ) ValueTask[int32] {
        var atLeast = atLeast
        if buffer.IsEmpty {
            return ValueTask[int32](0)
        }
        atLeast = Math.Clamp(atLeast, 1, buffer.Length)
        let taken = TryReceiveBatch(buffer.Span)
        if taken >= atLeast || IsClosed {
            return ValueTask[int32](taken)
        }
        return ReceiveBatchSlowAsync(buffer, atLeast, taken, cancellationToken)
    }

    /// Sends every element, parking without a thread while the channel cannot
    /// take more. Returns the count sent, which is the whole batch unless
    /// cancellation arrived mid-batch (then the count so far, so a retry can
    /// resume without duplicating).
    /// @param items The elements to send.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The count transferred.
    /// @exception ChannelClosedException The channel is or becomes closed.
    /// @exception OperationCanceledException Cancelled before any element was transferred.
    func SendBatchAsync(
        items ReadOnlyMemory[T],
        cancellationToken CancellationToken = default(CancellationToken)
    ) ValueTask[int32] {
        if items.IsEmpty {
            return ValueTask[int32](0)
        }
        let sent = TrySendBatch(items.Span)
        if sent == items.Length {
            return ValueTask[int32](sent)
        }
        return SendBatchSlowAsync(items, sent, cancellationToken)
    }

    private async func ReceiveBatchSlowAsync(
        buffer Memory[T],
        atLeast int32,
        taken int32,
        cancellationToken CancellationToken
    ) ValueTask[int32] {
        var buffer = buffer
        var taken = taken
        while taken < atLeast {
            var one ReceiveResult[T]
            try {
                one = await ReceiveAsync(cancellationToken).ConfigureAwait(false)
            } catch (OperationCanceledException) when taken > 0 {
                return taken
            }
            if !one.Ok {
                return taken
            }
            // `one.Ok` was checked above, so the three-state encoding
            // (ADR-0174 D3) guarantees a delivered value here.
            buffer.Span[taken] = one.Element
            taken++
            if taken < buffer.Length {
                taken += TryReceiveBatch(buffer.Span.Slice(taken))
            }
        }
        return taken
    }

    private async func SendBatchSlowAsync(
        items ReadOnlyMemory[T],
        sent int32,
        cancellationToken CancellationToken
    ) ValueTask[int32] {
        var sent = sent
        while sent < items.Length {
            try {
                await SendAsync(items.Span[sent], cancellationToken).ConfigureAwait(false)
            } catch (OperationCanceledException) when sent > 0 {
                return sent
            }
            sent++
            if sent < items.Length {
                sent += TrySendBatch(items.Span.Slice(sent))
            }
        }
        return sent
    }

    private func TryReceiveBatchLocked(buffer Span[T], ref completions Completions) int32 {
        var buffer = buffer
        var taken = 0
        while taken < buffer.Length && count > 0 {
            taken += DrainBufferInto(buffer[taken ..])
            // Issue #3902 S3: only consult the sender queue when there is one.
            // The old loop called RefillFromSenderLocked once per element, and
            // on a buffered channel with no parked sender — the common case —
            // every one of those calls was a queue probe that found nothing.
            if senders.Count == 0 {
                break
            }
            RefillFromSenderLocked(&completions)
        }
        // Rendezvous (or drained buffer with parked senders): sequential hand-offs.
        while taken < buffer.Length && senders.TryDequeue(out var node) {
            completions.Add(node!!)
            if node!!.TryCommitSend(out var handed) {
                buffer[taken] = handed
                taken++
            }
        }
        return taken
    }

    private func TrySendBatchLocked(items ReadOnlySpan[T], ref completions Completions) int32 {
        var sent = 0
        while sent < items.Length && receivers.TryDequeue(out var node) {
            completions.Add(node!!)
            if node!!.TryCommitReceive(items[sent]) {
                sent++
            }
        }
        while sent < items.Length && (isUnbounded || count < capacity) {
            EnqueueBuffer(items[sent])
            sent++
        }
        return sent
    }

    shared {
        /// Unwraps a receive-only handle back to the channel behind it, or
        /// `null` for a foreign (cref:ChannelReader{T}).
        /// This is what lets a batch operation on an `in chan[T]` take the
        /// one-lock fast path (ADR-0174 D10).
        /// @param reader The handle.
        /// @returns The owning channel, or `null`.
        internal func TryGetOwner(reader ChannelReader[T]?) Chan[T]? -> (reader as ChanReader)?.Owner

        /// Unwraps a send-only handle back to the channel behind it, or `null` for a foreign one.
        /// @param writer The handle.
        /// @returns The owning channel, or `null`.
        internal func TryGetOwner(writer ChannelWriter[T]?) Chan[T]? -> (writer as ChanWriter)?.Owner
    }
}
