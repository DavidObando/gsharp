// <copyright file="ChannelOps.Context.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The <see cref="Context"/>-taking forms of the facade (ADR-0174 D7): every
/// channel operation is a cancellation point that observes the ambient scope
/// context. Each forwards to the token form; the split exists so the emitter
/// passes the hidden context parameter straight through.
/// </summary>
public static partial class ChannelOps
{
    /// <summary>Receives one value under <paramref name="context"/>; see <see cref="Receive{T}(Channel{T}, CancellationToken)"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The received value, or the zero value when closed and drained.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T Receive<T>(Channel<T>? channel, Context context) => Receive(channel, context.Token);

    /// <summary>Receives one value from a reader under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The received value, or the zero value when closed and drained.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T Receive<T>(ChannelReader<T>? reader, Context context) => Receive(reader, context.Token);

    /// <summary>The two-value receive under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The value and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static (T Value, bool Ok) Receive2<T>(Channel<T>? channel, Context context) => Receive2(channel, context.Token);

    /// <summary>The two-value receive from a reader under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The value and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static (T Value, bool Ok) Receive2<T>(ChannelReader<T>? reader, Context context) => Receive2(reader, context.Token);

    /// <summary>Sends one value under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="value">The value.</param>
    /// <param name="context">The ambient context.</param>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void Send<T>(Channel<T>? channel, T value, Context context) => Send(channel, value, context.Token);

    /// <summary>Sends one value through a writer under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The writer, or <c>nil</c>.</param>
    /// <param name="value">The value.</param>
    /// <param name="context">The ambient context.</param>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void Send<T>(ChannelWriter<T>? writer, T value, Context context) => Send(writer, value, context.Token);

    /// <summary>The suspending receive under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The value and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask<ReceiveResult<T>> ReceiveAsync<T>(Channel<T>? channel, Context context) => ReceiveAsync(channel, context.Token);

    /// <summary>The suspending receive from a reader under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The value and whether the channel delivered it.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask<ReceiveResult<T>> ReceiveAsync<T>(ChannelReader<T>? reader, Context context) => ReceiveAsync(reader, context.Token);

    /// <summary>The suspending send under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="value">The value.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>A task that completes when the value has been accepted.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask SendAsync<T>(Channel<T>? channel, T value, Context context) => SendAsync(channel, value, context.Token);

    /// <summary>The suspending send through a writer under <paramref name="context"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The writer, or <c>nil</c>.</param>
    /// <param name="value">The value.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>A task that completes when the value has been accepted.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ValueTask SendAsync<T>(ChannelWriter<T>? writer, T value, Context context) => SendAsync(writer, value, context.Token);
}
