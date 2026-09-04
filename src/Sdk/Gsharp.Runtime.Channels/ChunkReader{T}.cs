// <copyright file="ChunkReader{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The reader behind <c>chunks(ch, n)</c> (ADR-0174 D10): a receive-only view
/// of a channel that hands over whole buffers instead of single elements, so
/// one lock acquisition and one park are amortized across a batch.
/// </summary>
/// <remarks>
/// <para>There is no goroutine here — a chunk is produced on the reader's own
/// thread, when it asks — so <c>for batch in chunks(input, 1024)</c> is
/// ordinary channel iteration with no extra child to join.</para>
/// <para>Each chunk owns a fresh array. Handing back a pooled buffer would
/// make the reader's lifetime the pool's problem, and the batch is
/// <em>communicated</em>, not borrowed: "share buffers by communicating" only
/// holds if the receiver may keep what it was handed. A pooled overload is a
/// measured follow-up (ADR-0174 gate G7), not a default.</para>
/// </remarks>
/// <typeparam name="T">The element type.</typeparam>
public sealed class ChunkReader<T> : ChannelReader<ReadOnlyMemory<T>>
{
    private readonly ChannelReader<T> source;
    private readonly int size;

    /// <summary>
    /// Initializes a new instance of the <see cref="ChunkReader{T}"/> class
    /// over a whole channel. This is the overload <c>chunks</c> binds: a
    /// <c>chan[T]</c> argument is a <see cref="Channel{T}"/> by identity,
    /// where a <c>ChannelReader[T]</c> parameter would need the
    /// <c>get_Reader</c> view conversion that applicability does not run for
    /// an open element (ADR-0174 errata).
    /// </summary>
    /// <param name="source">The channel to chunk.</param>
    /// <param name="size">The maximum chunk length; at least one.</param>
    public ChunkReader(Channel<T> source, int size)
        : this((source ?? throw new ArgumentNullException(nameof(source))).Reader, size)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="ChunkReader{T}"/> class over a receive-only handle.</summary>
    /// <param name="source">The channel to chunk.</param>
    /// <param name="size">The maximum chunk length; at least one.</param>
    public ChunkReader(ChannelReader<T> source, int size)
    {
        this.source = source ?? throw new ArgumentNullException(nameof(source));
        this.size = size > 0 ? size : throw new ArgumentOutOfRangeException(nameof(size), size, "A chunk holds at least one element.");
    }

    /// <inheritdoc/>
    public override Task Completion => source.Completion;

    /// <summary>
    /// Gets how many elements are known to be waiting, or <c>size</c> when the
    /// source cannot say (issue #3902 S3). A G#-owned channel can answer
    /// exactly; a foreign reader is asked for a lower bound, and the
    /// conservative answer keeps the old behaviour rather than skipping a read.
    /// </summary>
    private int Available => source switch
    {
        Chan<T>.ChanReader owned => owned.Owner.Length(),
        _ => source.CanCount ? source.Count : size,
    };

    /// <inheritdoc/>
    /// <remarks>
    /// Issue #3902 (S3): the array is sized to what is actually there, and is
    /// not allocated at all when nothing is. This path is probed by the
    /// readiness/re-probe loop a foreign reader goes through, so an empty
    /// channel used to throw away one <c>T[size]</c> per probe — at a chunk
    /// size of 1024 that dominated everything else the scenario did.
    /// </remarks>
    public override bool TryRead(out ReadOnlyMemory<T> item)
    {
        var available = Available;
        if (available == 0)
        {
            item = default;
            return false;
        }

        var buffer = new T[Math.Min(size, available)];
        var taken = source.TryReceiveBatch(buffer.AsSpan());
        if (taken == 0)
        {
            item = default;
            return false;
        }

        item = new ReadOnlyMemory<T>(buffer, 0, taken);
        return true;
    }

    /// <inheritdoc/>
    public override ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken = default)
        => source.WaitToReadAsync(cancellationToken);

    /// <inheritdoc/>
    public override async ValueTask<ReadOnlyMemory<T>> ReadAsync(CancellationToken cancellationToken = default)
    {
        var buffer = new T[size];

        // atLeast = 1 is the Go `range` shape: take what is there rather than
        // wait to fill. A full-fill barrier is ReceiveBatch's business, not a
        // chunked loop's — waiting for a whole chunk would stall a pipeline
        // whose producer is slower than its consumer.
        var taken = await source.ReceiveBatch(buffer, atLeast: 1, Context.FromToken(cancellationToken)).ConfigureAwait(false);
        if (taken == 0)
        {
            throw new ChannelClosedException();
        }

        return new ReadOnlyMemory<T>(buffer, 0, taken);
    }
}
