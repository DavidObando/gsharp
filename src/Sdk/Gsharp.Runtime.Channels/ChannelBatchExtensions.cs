// <copyright file="ChannelBatchExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// Bulk transfer on a directional channel handle (ADR-0174 D10). An
/// <c>in chan[T]</c> <em>is</em> a <see cref="ChannelReader{T}"/> and an
/// <c>out chan[T]</c> a <see cref="ChannelWriter{T}"/>, so this is where the
/// ADR's <c>func (ch in chan[T]) …</c> receiver spelling binds.
/// </summary>
/// <remarks>
/// <para>The API is split by whether it can park, because that decides what
/// buffer it can accept. The non-suspending forms take a
/// <see cref="Span{T}"/>: they never cross a suspension point, so a stack view
/// is safe. The suspending forms take <see cref="Memory{T}"/>, because a
/// destination that must survive a park cannot be ref-like — it has to be
/// hoisted into a heap-allocated state machine.</para>
/// <para>Each method takes the fast path when the handle belongs to a
/// <see cref="Chan{T}"/> — one lock acquisition and one park for the whole
/// batch — and otherwise degrades to the element-wise loop a foreign
/// <see cref="Channel{T}"/> supports. The slogan is "share <em>buffers</em> by
/// communicating": owned memory, handed over.</para>
/// </remarks>
public static class ChannelBatchExtensions
{
    /// <summary>
    /// Takes as many available elements as fit, without parking. Returns 0
    /// when nothing is available <em>or</em> the channel is closed and
    /// drained.
    /// </summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The receive-only handle.</param>
    /// <param name="buffer">The destination.</param>
    /// <returns>The number of elements written.</returns>
    public static int TryReceiveBatch<T>(this ChannelReader<T> reader, Span<T> buffer)
    {
        ArgumentNullException.ThrowIfNull(reader);
        if (Chan<T>.TryGetOwner(reader) is { } owner)
        {
            return owner.TryReceiveBatch(buffer);
        }

        var taken = 0;
        while (taken < buffer.Length && reader.TryRead(out var item))
        {
            buffer[taken] = item;
            taken++;
        }

        return taken;
    }

    /// <summary>Sends as many elements as parked receivers and buffer room will take, without parking.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The send-only handle.</param>
    /// <param name="items">The elements to send.</param>
    /// <returns>The number of elements accepted.</returns>
    public static int TrySendBatch<T>(this ChannelWriter<T> writer, ReadOnlySpan<T> items)
    {
        ArgumentNullException.ThrowIfNull(writer);
        if (Chan<T>.TryGetOwner(writer) is { } owner)
        {
            return owner.TrySendBatch(items);
        }

        var sent = 0;
        while (sent < items.Length && writer.TryWrite(items[sent]))
        {
            sent++;
        }

        return sent;
    }

    /// <summary>
    /// Receives at least <paramref name="atLeast"/> elements (up to
    /// <paramref name="buffer"/>'s length), parking without a thread while
    /// fewer are available. <c>atLeast = 1</c> is Go's <c>range</c>-like "take
    /// what is there"; <c>atLeast = buffer.Length</c> is a full-fill barrier.
    /// </summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The receive-only handle.</param>
    /// <param name="buffer">The destination.</param>
    /// <param name="atLeast">The minimum count to wait for, clamped to <c>[1, buffer.Length]</c>.</param>
    /// <param name="context">The ambient cancellation context.</param>
    /// <returns>
    /// The count transferred: at least <paramref name="atLeast"/> normally;
    /// fewer (possibly 0) when the channel closed mid-batch; and the count so
    /// far when cancellation arrives after at least one element moved — never
    /// a bare throw that hides the count and invites duplicates on retry.
    /// </returns>
    [Suspending]
    public static ValueTask<int> ReceiveBatch<T>(this ChannelReader<T> reader, Memory<T> buffer, int atLeast, Context? context = null)
    {
        ArgumentNullException.ThrowIfNull(reader);
        var token = context?.Token ?? default;
        return Chan<T>.TryGetOwner(reader) is { } owner
            ? owner.ReceiveBatchAsync(buffer, atLeast, token)
            : ReceiveBatchForeignAsync(reader, buffer, atLeast, token);
    }

    /// <summary>Sends every element, parking without a thread while the channel cannot take more.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The send-only handle.</param>
    /// <param name="items">The elements to send.</param>
    /// <param name="context">The ambient cancellation context.</param>
    /// <returns>The count transferred, which is the whole batch unless cancellation arrived mid-batch.</returns>
    [Suspending]
    public static ValueTask<int> SendBatch<T>(this ChannelWriter<T> writer, ReadOnlyMemory<T> items, Context? context = null)
    {
        ArgumentNullException.ThrowIfNull(writer);
        var token = context?.Token ?? default;
        return Chan<T>.TryGetOwner(writer) is { } owner
            ? owner.SendBatchAsync(items, token)
            : SendBatchForeignAsync(writer, items, token);
    }

    private static async ValueTask<int> ReceiveBatchForeignAsync<T>(ChannelReader<T> reader, Memory<T> buffer, int atLeast, CancellationToken token)
    {
        if (buffer.IsEmpty)
        {
            return 0;
        }

        atLeast = Math.Clamp(atLeast, 1, buffer.Length);
        var taken = 0;
        while (taken < atLeast)
        {
            try
            {
                if (!await reader.WaitToReadAsync(token).ConfigureAwait(false))
                {
                    return taken;
                }
            }
            catch (OperationCanceledException) when (taken > 0)
            {
                return taken;
            }
            catch (ChannelClosedException)
            {
                return taken;
            }

            // A competing consumer may have taken the value the wait promised,
            // so the drain is a try-loop, not a single read (ADR-0174 D2).
            while (taken < buffer.Length && reader.TryRead(out var item))
            {
                buffer.Span[taken] = item;
                taken++;
            }
        }

        return taken;
    }

    private static async ValueTask<int> SendBatchForeignAsync<T>(ChannelWriter<T> writer, ReadOnlyMemory<T> items, CancellationToken token)
    {
        var sent = 0;
        while (sent < items.Length)
        {
            try
            {
                await writer.WriteAsync(items.Span[sent], token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (sent > 0)
            {
                return sent;
            }

            sent++;
        }

        return sent;
    }
}
