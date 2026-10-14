// <copyright file="Chan{T}.Writer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// ```xmldoc
/// <content>The <see cref="ChannelWriter{T}" /> view — what <c>out chan[T]</c> is.</content>
/// ```
partial class Chan[T] : Channel[T], ISelectable[T], ISendSelectableCore[T], IDisposable {
    /// The BCL writer over a (cref:Chan{T}). (cref:TryComplete)
    /// with an error is rejected: a (cref:Chan{T}) never faults, close
    /// is the only completion it has (ADR-0174 D2).
    internal class ChanWriter : ChannelWriter[T] {
        /// Initializes a new instance of the (cref:ChanWriter) class.
        /// @param owner The channel.
        internal init(owner Chan[T]) {
            Owner = owner
        }

        /// Gets the channel this writer writes to.
        internal prop Owner Chan[T] {
            get;
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func TryWrite(item T) bool -> Owner.TrySendCore(item) == SendOutcome.Sent

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func WriteAsync(
            item T,
            cancellationToken CancellationToken = default(CancellationToken)
        ) ValueTask -> Owner.SendAsync(item, cancellationToken)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func WaitToWriteAsync(cancellationToken CancellationToken = default(CancellationToken)) ValueTask[
            bool
        ] -> Owner.WaitToWriteAsync(cancellationToken)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func TryComplete(error Exception? = nil) bool {
            if error != nil {
                throw NotSupportedException(
                    "A G# channel never faults; use Close() — close is the only completion it has (ADR-0174 D2)."
                )
            }
            return Owner.TryClose()
        }
    }
}
