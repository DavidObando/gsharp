// <copyright file="Chan{T}.Reader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// ```xmldoc
/// <content>The <see cref="ChannelReader{T}" /> view — what <c>in chan[T]</c> is.</content>
/// ```
partial class Chan[T] : Channel[T], ISelectable[T], ISendSelectableCore[T], IDisposable {
    /// The BCL reader over a (cref:Chan{T}). Honors the
    /// (cref:ChannelReader{T}) contract exactly (so `ReadAllAsync`
    /// and `await foreach` work unmodified) and carries an
    /// (cref:Owner) back-reference so an `in chan[T]` handle can
    /// be unwrapped to the fast path.
    internal class ChanReader : ChannelReader[T] {
        /// Initializes a new instance of the (cref:ChanReader) class.
        /// @param owner The channel.
        internal init(owner Chan[T]) {
            Owner = owner
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop Completion Task -> Owner.completion.Task

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop CanCount bool -> true

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop Count int32 -> Owner.Length()

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop CanPeek bool -> false

        /// Gets the channel this reader reads from.
        internal prop Owner Chan[T] {
            get;
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func TryRead(@MaybeNullWhen(false) out item T) bool {
            if Owner.TryReceive(out var value, out var ok) && ok {
                // `ok` is true, so the three-state encoding (ADR-0174 D3)
                // guarantees a delivered value rather than the zero value.
                let delivered = ReceiveResult[T](value, ok)
                item = delivered.Element
                return true
            }
            item = default(T)
            return false
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func ReadAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[T] {
            let pending = Owner.ReceiveAsync(cancellationToken)
            if pending.IsCompletedSuccessfully {
                let result = pending.Result
                // Guarded by `result.Ok`: the value was delivered (ADR-0174 D3).
                return if result.Ok {
                    ValueTask[T](result.Element)
                } else {
                    ValueTask.FromException[T](ChannelClosedException())
                }
            }
            return ReadSlowAsync(pending)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func WaitToReadAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[
            bool
        ] -> Owner.WaitToReadAsync(cancellationToken)

        shared {
            private async func ReadSlowAsync(pending ValueTask[ReceiveResult[T]]) ValueTask[T] {
                let result = await pending.ConfigureAwait(false)
                if !result.Ok {
                    throw ChannelClosedException()
                }
                // Past the `!result.Ok` throw above, so a value was delivered.
                return result.Element
            }
        }
    }
}
