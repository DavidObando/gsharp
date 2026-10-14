// <copyright file="ChunkReader{T}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// The reader behind `chunks(ch, n)` (ADR-0174 D10): a receive-only view
/// of a channel that hands over whole buffers instead of single elements, so
/// one lock acquisition and one park are amortized across a batch.
/// @remarks There is no goroutine here — a chunk is produced on the reader's own
/// thread, when it asks — so `for batch in chunks(input, 1024)` is
/// ordinary channel iteration with no extra child to join.
///
/// Each chunk owns a fresh array. Handing back a pooled buffer would
/// make the reader's lifetime the pool's problem, and the batch is
/// <em>communicated</em>, not borrowed: "share buffers by communicating" only
/// holds if the receiver may keep what it was handed. A pooled overload is a
/// measured follow-up (ADR-0174 gate G7), not a default.
/// @typeparam T The element type.
class ChunkReader[T] : ChannelReader[ReadOnlyMemory[T]] {
    private let source ChannelReader[T]
    private let size int32

    /// Initializes a new instance of the (cref:ChunkReader{T}) class
    /// over a whole channel. This is the overload `chunks` binds: a
    /// `chan[T]` argument is a (cref:Channel{T}) by identity, and
    /// since issue #3876 that holds for an open element type too, so
    /// `chunks` reaches this constructor directly instead of through
    /// `Chunks.Of[T]`.
    /// @param source The channel to chunk.
    /// @param size The maximum chunk length; at least one.
    convenience init(source Channel[T], size int32) {
        init((source ?? throw ArgumentNullException("source")).Reader, size)
    }

    /// Initializes a new instance of the (cref:ChunkReader{T}) class over a receive-only handle.
    /// @param source The channel to chunk.
    /// @param size The maximum chunk length; at least one.
    init(source ChannelReader[T], size int32) {
        this.source = source ?? throw ArgumentNullException("source")
        this.size = if size > 0 {
            size
        } else {
            throw ArgumentOutOfRangeException("size", size, "A chunk holds at least one element.")
            default(int32)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Completion Task -> source.Completion

    /// Gets how many elements are known to be waiting, or `size` when the
    /// source cannot say (issue #3902 S3). A G#-owned channel can answer
    /// exactly; a foreign reader is asked for a lower bound, and the
    /// conservative answer keeps the old behaviour rather than skipping a read.
    private prop Available int32 -> switch source {
        case owned is Chan[T].ChanReader: owned.Owner.Length()
        default: if source.CanCount {
            source.Count
        } else {
            size
        }
    }

    /// @remarks Issue #3902 (S3): the array is sized to what is actually there, and is
    /// not allocated at all when nothing is. This path is probed by the
    /// readiness/re-probe loop a foreign reader goes through, so an empty
    /// channel used to throw away one `T[size]` per probe — at a chunk
    /// size of 1024 that dominated everything else the scenario did.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func TryRead(out item ReadOnlyMemory[T]) bool {
        let available = Available
        if available == 0 {
            item = default(ReadOnlyMemory[T])
            return false
        }
        let buffer = [Math.Min(size, available)]T
        let taken = source.TryReceiveBatch(buffer.AsSpan())
        if taken == 0 {
            item = default(ReadOnlyMemory[T])
            return false
        }
        item = ReadOnlyMemory[T](buffer, 0, taken)
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func WaitToReadAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[
        bool
    ] -> source.WaitToReadAsync(cancellationToken)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override async func ReadAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[
        ReadOnlyMemory[T]
    ] {
        let buffer = [size]T
        // atLeast = 1 is the Go `range` shape: take what is there rather than
        // wait to fill. A full-fill barrier is ReceiveBatch's business, not a
        // chunked loop's — waiting for a whole chunk would stall a pipeline
        // whose producer is slower than its consumer.
        let taken = await source.ReceiveBatch(buffer, atLeast: 1, Context.FromToken(cancellationToken)).ConfigureAwait(
            false
        )
        if taken == 0 {
            throw ChannelClosedException()
        }
        return ReadOnlyMemory[T](buffer, 0, taken)
    }
}
