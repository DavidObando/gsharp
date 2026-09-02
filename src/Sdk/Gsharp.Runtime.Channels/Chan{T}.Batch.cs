// <copyright file="Chan{T}.Batch.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <content>Bulk transfer (ADR-0174 D10): "share <em>buffers</em> by communicating".</content>
public sealed partial class Chan<T>
{
    /// <summary>
    /// Takes as many buffered (or parked-sender) elements as fit, without
    /// parking. One lock acquisition for the whole batch. Returns 0 when
    /// nothing is available <em>or</em> the channel is closed and drained —
    /// check <see cref="IsClosed"/> to tell them apart.
    /// </summary>
    /// <param name="buffer">The destination; a <see cref="Span{T}"/> is legal because this never crosses a suspension point.</param>
    /// <returns>The number of elements written.</returns>
    public int TryReceiveBatch(Span<T> buffer)
    {
        if (buffer.IsEmpty)
        {
            return 0;
        }

        var completions = default(Completions);
        int taken;
        lock (gate)
        {
            taken = TryReceiveBatchLocked(buffer, ref completions);
        }

        completions.Publish();
        return taken;
    }

    /// <summary>
    /// Sends as many elements as parked receivers and buffer room will take,
    /// without parking. One lock acquisition for the whole batch.
    /// </summary>
    /// <param name="items">The elements to offer.</param>
    /// <returns>The number of elements transferred.</returns>
    /// <exception cref="ChannelClosedException">The channel is closed.</exception>
    public int TrySendBatch(ReadOnlySpan<T> items)
    {
        if (items.IsEmpty)
        {
            return 0;
        }

        var completions = default(Completions);
        int sent;
        lock (gate)
        {
            if (closed)
            {
                throw new ChannelClosedException("send on closed channel");
            }

            sent = TrySendBatchLocked(items, ref completions);
        }

        completions.Publish();
        return sent;
    }

    /// <summary>
    /// Receives at least <paramref name="atLeast"/> elements (and up to
    /// <paramref name="buffer"/>'s length), parking without a thread while
    /// fewer are available. <c>atLeast = 1</c> is Go's <c>range</c>-like
    /// "take what is there"; <c>atLeast = buffer.Length</c> is a full-fill
    /// barrier. A <see cref="Memory{T}"/> because the destination must
    /// survive a suspension.
    /// </summary>
    /// <param name="buffer">The destination.</param>
    /// <param name="atLeast">The minimum count to wait for, clamped to <c>[1, buffer.Length]</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>
    /// The count transferred: at least <paramref name="atLeast"/> normally;
    /// fewer (possibly 0) when the channel closed mid-batch — the next call
    /// reports closed; and the count so far when cancellation arrives after at
    /// least one element moved (ADR-0174 D7's linearization rule — never a bare
    /// throw that hides the count and invites duplicates on retry).
    /// </returns>
    /// <exception cref="OperationCanceledException">Cancelled before any element was transferred.</exception>
    public ValueTask<int> ReceiveBatchAsync(Memory<T> buffer, int atLeast, CancellationToken cancellationToken = default)
    {
        if (buffer.IsEmpty)
        {
            return new ValueTask<int>(0);
        }

        atLeast = Math.Clamp(atLeast, 1, buffer.Length);
        var taken = TryReceiveBatch(buffer.Span);
        if (taken >= atLeast || IsClosed)
        {
            return new ValueTask<int>(taken);
        }

        return ReceiveBatchSlowAsync(buffer, atLeast, taken, cancellationToken);
    }

    /// <summary>
    /// Sends every element, parking without a thread while the channel cannot
    /// take more. Returns the count sent, which is the whole batch unless
    /// cancellation arrived mid-batch (then the count so far, so a retry can
    /// resume without duplicating).
    /// </summary>
    /// <param name="items">The elements to send.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The count transferred.</returns>
    /// <exception cref="ChannelClosedException">The channel is or becomes closed.</exception>
    /// <exception cref="OperationCanceledException">Cancelled before any element was transferred.</exception>
    public ValueTask<int> SendBatchAsync(ReadOnlyMemory<T> items, CancellationToken cancellationToken = default)
    {
        if (items.IsEmpty)
        {
            return new ValueTask<int>(0);
        }

        var sent = TrySendBatch(items.Span);
        if (sent == items.Length)
        {
            return new ValueTask<int>(sent);
        }

        return SendBatchSlowAsync(items, sent, cancellationToken);
    }

    private async ValueTask<int> ReceiveBatchSlowAsync(Memory<T> buffer, int atLeast, int taken, CancellationToken cancellationToken)
    {
        while (taken < atLeast)
        {
            ReceiveResult<T> one;
            try
            {
                one = await ReceiveAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (taken > 0)
            {
                return taken;
            }

            if (!one.Ok)
            {
                return taken;
            }

            buffer.Span[taken++] = one.Value;
            if (taken < buffer.Length)
            {
                taken += TryReceiveBatch(buffer.Span.Slice(taken));
            }
        }

        return taken;
    }

    private async ValueTask<int> SendBatchSlowAsync(ReadOnlyMemory<T> items, int sent, CancellationToken cancellationToken)
    {
        while (sent < items.Length)
        {
            try
            {
                await SendAsync(items.Span[sent], cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (sent > 0)
            {
                return sent;
            }

            sent++;
            if (sent < items.Length)
            {
                sent += TrySendBatch(items.Span.Slice(sent));
            }
        }

        return sent;
    }

    private int TryReceiveBatchLocked(Span<T> buffer, ref Completions completions)
    {
        var taken = 0;
        while (taken < buffer.Length && count > 0)
        {
            buffer[taken++] = DequeueBuffer();
            RefillFromSenderLocked(ref completions);
        }

        // Rendezvous (or drained buffer with parked senders): sequential hand-offs.
        while (taken < buffer.Length && senders.TryDequeue(out var node))
        {
            completions.Add(node);
            if (node.TryCommitSend(out var handed))
            {
                buffer[taken++] = handed;
            }
        }

        return taken;
    }

    private int TrySendBatchLocked(ReadOnlySpan<T> items, ref Completions completions)
    {
        var sent = 0;
        while (sent < items.Length && receivers.TryDequeue(out var node))
        {
            completions.Add(node);
            if (node.TryCommitReceive(items[sent]))
            {
                sent++;
            }
        }

        while (sent < items.Length && (isUnbounded || count < capacity))
        {
            EnqueueBuffer(items[sent++]);
        }

        return sent;
    }
}
