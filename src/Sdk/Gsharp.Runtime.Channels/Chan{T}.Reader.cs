// <copyright file="Chan{T}.Reader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <content>The <see cref="ChannelReader{T}"/> view — what <c>in chan[T]</c> is.</content>
public sealed partial class Chan<T>
{
    /// <summary>
    /// The BCL reader over a <see cref="Chan{T}"/>. Honors the
    /// <see cref="ChannelReader{T}"/> contract exactly (so <c>ReadAllAsync</c>
    /// and <c>await foreach</c> work unmodified) and carries an
    /// <see cref="Owner"/> back-reference so an <c>in chan[T]</c> handle can
    /// be unwrapped to the fast path.
    /// </summary>
    internal sealed class ChanReader : ChannelReader<T>
    {
        /// <summary>Initializes a new instance of the <see cref="ChanReader"/> class.</summary>
        /// <param name="owner">The channel.</param>
        internal ChanReader(Chan<T> owner)
        {
            Owner = owner;
        }

        /// <inheritdoc/>
        public override Task Completion => Owner.completion.Task;

        /// <inheritdoc/>
        public override bool CanCount => true;

        /// <inheritdoc/>
        public override int Count => Owner.Length();

        /// <inheritdoc/>
        public override bool CanPeek => false;

        /// <summary>Gets the channel this reader reads from.</summary>
        internal Chan<T> Owner { get; }

        /// <inheritdoc/>
        public override bool TryRead([MaybeNullWhen(false)] out T item)
        {
            if (Owner.TryReceive(out var value, out var ok) && ok)
            {
                // `ok` is true, so the three-state encoding (ADR-0174 D3)
                // guarantees a delivered value rather than the zero value.
                item = value!;
                return true;
            }

            item = default;
            return false;
        }

        /// <inheritdoc/>
        public override ValueTask<T> ReadAsync(CancellationToken cancellationToken = default)
        {
            var pending = Owner.ReceiveAsync(cancellationToken);
            if (pending.IsCompletedSuccessfully)
            {
                var result = pending.Result;

                // Guarded by `result.Ok`: the value was delivered (ADR-0174 D3).
                return result.Ok
                    ? new ValueTask<T>(result.Value!)
                    : ValueTask.FromException<T>(new ChannelClosedException());
            }

            return ReadSlowAsync(pending);
        }

        /// <inheritdoc/>
        public override ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken = default)
            => Owner.WaitToReadAsync(cancellationToken);

        private static async ValueTask<T> ReadSlowAsync(ValueTask<ReceiveResult<T>> pending)
        {
            var result = await pending.ConfigureAwait(false);
            if (!result.Ok)
            {
                throw new ChannelClosedException();
            }

            // Past the `!result.Ok` throw above, so a value was delivered.
            return result.Value!;
        }
    }
}
