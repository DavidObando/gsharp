// <copyright file="ChannelOps.Awaited.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The suspending receives shaped for an implicit <c>await</c> (ADR-0174 D4):
/// <see cref="ReceiveValueAsync{T}(Channel{T}, CancellationToken)"/> yields the
/// element (its zero value once closed) and
/// <see cref="ReceiveTupleAsync{T}(Channel{T}, CancellationToken)"/> the
/// <c>(T, bool)</c> of the two-value receive — so the compiler awaits one call
/// and reads no member of <see cref="ReceiveResult{T}"/> in emitted IL. Both
/// complete synchronously when a value is ready and allocate nothing then.
/// </summary>
public static partial class ChannelOps
{
    /// <summary>Receives one value, suspending while none is available; the zero value once the channel is closed and drained.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c> (parks until cancelled).</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The element, or the zero value when closed.</returns>
    public static ValueTask<T> ReceiveValueAsync<T>(Channel<T>? channel, CancellationToken cancellationToken)
        => Unwrap(ReceiveAsync(channel, cancellationToken));

    /// <summary>Receives one value from a reader, suspending while none is available.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c> (parks until cancelled).</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The element, or the zero value when closed.</returns>
    public static ValueTask<T> ReceiveValueAsync<T>(ChannelReader<T>? reader, CancellationToken cancellationToken)
        => Unwrap(ReceiveAsync(reader, cancellationToken));

    /// <summary>The suspending two-value receive as a tuple.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c> (parks until cancelled).</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The element and whether the channel delivered it.</returns>
    public static ValueTask<(T Value, bool Ok)> ReceiveTupleAsync<T>(Channel<T>? channel, CancellationToken cancellationToken)
        => ToTuple(ReceiveAsync(channel, cancellationToken));

    /// <summary>The suspending two-value receive from a reader as a tuple.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c> (parks until cancelled).</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The element and whether the channel delivered it.</returns>
    public static ValueTask<(T Value, bool Ok)> ReceiveTupleAsync<T>(ChannelReader<T>? reader, CancellationToken cancellationToken)
        => ToTuple(ReceiveAsync(reader, cancellationToken));

    /// <summary>Receives one value under <paramref name="context"/>; see <see cref="ReceiveValueAsync{T}(Channel{T}, CancellationToken)"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The element, or the zero value when closed.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask<T> ReceiveValueAsync<T>(Channel<T>? channel, Context context) => ReceiveValueAsync(channel, context.Token);

    /// <summary>Receives one value from a reader under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The element, or the zero value when closed.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask<T> ReceiveValueAsync<T>(ChannelReader<T>? reader, Context context) => ReceiveValueAsync(reader, context.Token);

    /// <summary>The suspending two-value receive under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The element and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask<(T Value, bool Ok)> ReceiveTupleAsync<T>(Channel<T>? channel, Context context) => ReceiveTupleAsync(channel, context.Token);

    /// <summary>The suspending two-value receive from a reader under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The element and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask<(T Value, bool Ok)> ReceiveTupleAsync<T>(ChannelReader<T>? reader, Context context) => ReceiveTupleAsync(reader, context.Token);

    private static ValueTask<T> Unwrap<T>(ValueTask<ReceiveResult<T>> pending)
    {
        if (pending.IsCompletedSuccessfully)
        {
            return new ValueTask<T>(pending.Result.Value);
        }

        return Awaited(pending);

        static async ValueTask<T> Awaited(ValueTask<ReceiveResult<T>> pending)
        {
            var result = await pending.ConfigureAwait(false);
            return result.Value;
        }
    }

    private static ValueTask<(T Value, bool Ok)> ToTuple<T>(ValueTask<ReceiveResult<T>> pending)
    {
        if (pending.IsCompletedSuccessfully)
        {
            var result = pending.Result;
            return new ValueTask<(T Value, bool Ok)>((result.Value, result.Ok));
        }

        return Awaited(pending);

        static async ValueTask<(T Value, bool Ok)> Awaited(ValueTask<ReceiveResult<T>> pending)
        {
            var result = await pending.ConfigureAwait(false);
            return (result.Value, result.Ok);
        }
    }
}
