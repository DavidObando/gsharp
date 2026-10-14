// <copyright file="ChannelBatchExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// Bulk transfer on a directional channel handle (ADR-0174 D10). An
/// `in chan[T]` <em>is</em> a (cref:ChannelReader{T}) and an
/// `out chan[T]` a (cref:ChannelWriter{T}), so this is where the
/// ADR's `func (ch in chan[T]) …` receiver spelling binds.
/// @remarks The API is split by whether it can park, because that decides what
/// buffer it can accept. The non-suspending forms take a
/// (cref:Span{T}): they never cross a suspension point, so a stack view
/// is safe. The suspending forms take (cref:Memory{T}), because a
/// destination that must survive a park cannot be ref-like — it has to be
/// hoisted into a heap-allocated state machine.
///
/// Four methods, not eight. Until issue #3877 the directional handles
/// each needed a `Channel<T>` twin, because an imported generic
/// extension on a `ChannelReader<T>` was member-not-found on the
/// `chan[T]` every caller actually writes (ADR-0174 errata 32/41). The
/// receiver now views along the D2 lattice like any other operand, so the
/// twins are gone and `ch.ReceiveBatch(…)` reaches the reader form
/// directly.
///
/// Each method takes the fast path when the handle belongs to a
/// (cref:Chan{T}) — one lock acquisition and one park for the whole
/// batch — and otherwise degrades to the element-wise loop a foreign
/// (cref:Channel{T}) supports. The slogan is "share <em>buffers</em> by
/// communicating": owned memory, handed over.
shared class ChannelBatchExtensions {
    private async func ReceiveBatchForeignAsync[T](
        reader ChannelReader[T],
        buffer Memory[T],
        atLeast int32,
        token CancellationToken
    ) ValueTask[int32] {
        var buffer = buffer
        var atLeast = atLeast
        if buffer.IsEmpty {
            return 0
        }
        atLeast = Math.Clamp(atLeast, 1, buffer.Length)
        var taken = 0
        while taken < atLeast {
            try {
                if !await reader.WaitToReadAsync(token).ConfigureAwait(false) {
                    return taken
                }
            } catch (OperationCanceledException) when taken > 0 {
                return taken
            } catch (ChannelClosedException) {
                return taken
            }
            // A competing consumer may have taken the value the wait promised,
            // so the drain is a try-loop, not a single read (ADR-0174 D2).
            while taken < buffer.Length && reader.TryRead(out var item) {
                buffer.Span[taken] = item
                taken++
            }
        }
        return taken
    }

    private async func SendBatchForeignAsync[T](
        writer ChannelWriter[T],
        items ReadOnlyMemory[T],
        token CancellationToken
    ) ValueTask[int32] {
        var sent = 0
        while sent < items.Length {
            try {
                await writer.WriteAsync(items.Span[sent], token).ConfigureAwait(false)
            } catch (OperationCanceledException) when sent > 0 {
                return sent
            }
            sent++
        }
        return sent
    }
}

/// Takes as many available elements as fit, without parking. Returns 0
/// when nothing is available <em>or</em> the channel is closed and
/// drained.
/// @typeparam T The element type.
/// @param buffer The destination.
/// @returns The number of elements written.
@ExtensionOwner(typeof(ChannelBatchExtensions))
func (reader ChannelReader[T]) TryReceiveBatch[T](buffer Span[T]) int32 {
    var buffer = buffer
    ArgumentNullException.ThrowIfNull(reader, paramName: "reader")
    if Chan[T].TryGetOwner(reader) is {} owner {
        return owner.TryReceiveBatch(buffer)
    }
    var taken = 0
    while taken < buffer.Length && reader.TryRead(out var item) {
        buffer[taken] = item
        taken++
    }
    return taken
}

/// Sends as many elements as parked receivers and buffer room will take, without parking.
/// @typeparam T The element type.
/// @param items The elements to send.
/// @returns The number of elements accepted.
@ExtensionOwner(typeof(ChannelBatchExtensions))
func (writer ChannelWriter[T]) TrySendBatch[T](items ReadOnlySpan[T]) int32 {
    ArgumentNullException.ThrowIfNull(writer, paramName: "writer")
    if Chan[T].TryGetOwner(writer) is {} owner {
        return owner.TrySendBatch(items)
    }
    var sent = 0
    while sent < items.Length && writer.TryWrite(items[sent]) {
        sent++
    }
    return sent
}

/// Receives at least [`atLeast`](paramref) elements (up to
/// [`buffer`](paramref)'s length), parking without a thread while
/// fewer are available. `atLeast = 1` is Go's `range`-like "take
/// what is there"; `atLeast = buffer.Length` is a full-fill barrier.
/// @typeparam T The element type.
/// @param buffer The destination.
/// @param atLeast The minimum count to wait for, clamped to `[1, buffer.Length]`.
/// @param context The ambient cancellation context.
/// @returns The count transferred: at least [`atLeast`](paramref) normally;
/// fewer (possibly 0) when the channel closed mid-batch; and the count so
/// far when cancellation arrives after at least one element moved — never
/// a bare throw that hides the count and invites duplicates on retry.
@ExtensionOwner(typeof(ChannelBatchExtensions))
func (reader ChannelReader[T]) ReceiveBatch[T](buffer Memory[T], atLeast int32, context Context? = nil) ValueTask[
    int32
] {
    ArgumentNullException.ThrowIfNull(reader, paramName: "reader")
    let token = context?.Token ?? default(CancellationToken)
    return if Chan[T].TryGetOwner(reader) is {} owner {
        owner.ReceiveBatchAsync(buffer, atLeast, token)
    } else {
        ChannelBatchExtensions.ReceiveBatchForeignAsync(reader, buffer, atLeast, token)
    }
}

/// Sends every element, parking without a thread while the channel cannot take more.
/// @typeparam T The element type.
/// @param items The elements to send.
/// @param context The ambient cancellation context.
/// @returns The count transferred, which is the whole batch unless cancellation arrived mid-batch.
@ExtensionOwner(typeof(ChannelBatchExtensions))
func (writer ChannelWriter[T]) SendBatch[T](items ReadOnlyMemory[T], context Context? = nil) ValueTask[int32] {
    ArgumentNullException.ThrowIfNull(writer, paramName: "writer")
    let token = context?.Token ?? default(CancellationToken)
    return if Chan[T].TryGetOwner(writer) is {} owner {
        owner.SendBatchAsync(items, token)
    } else {
        ChannelBatchExtensions.SendBatchForeignAsync(writer, items, token)
    }
}
