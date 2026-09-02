// <copyright file="Chan{T}.Writer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <content>The <see cref="ChannelWriter{T}"/> view — what <c>out chan[T]</c> is.</content>
public sealed partial class Chan<T>
{
    /// <summary>
    /// The BCL writer over a <see cref="Chan{T}"/>. <see cref="TryComplete"/>
    /// with an error is rejected: a <see cref="Chan{T}"/> never faults, close
    /// is the only completion it has (ADR-0174 D2).
    /// </summary>
    internal sealed class ChanWriter : ChannelWriter<T>
    {
        /// <summary>Initializes a new instance of the <see cref="ChanWriter"/> class.</summary>
        /// <param name="owner">The channel.</param>
        internal ChanWriter(Chan<T> owner)
        {
            Owner = owner;
        }

        /// <summary>Gets the channel this writer writes to.</summary>
        internal Chan<T> Owner { get; }

        /// <inheritdoc/>
        public override bool TryWrite(T item) => Owner.TrySendCore(item) == SendOutcome.Sent;

        /// <inheritdoc/>
        public override ValueTask WriteAsync(T item, CancellationToken cancellationToken = default)
            => Owner.SendAsync(item, cancellationToken);

        /// <inheritdoc/>
        public override ValueTask<bool> WaitToWriteAsync(CancellationToken cancellationToken = default)
            => Owner.WaitToWriteAsync(cancellationToken);

        /// <inheritdoc/>
        public override bool TryComplete(Exception? error = null)
        {
            if (error is not null)
            {
                throw new NotSupportedException("A G# channel never faults; use Close() — close is the only completion it has (ADR-0174 D2).");
            }

            return Owner.TryClose();
        }
    }
}
