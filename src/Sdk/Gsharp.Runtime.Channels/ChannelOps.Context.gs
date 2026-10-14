// <copyright file="ChannelOps.Context.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// The (cref:Context)-taking forms of the facade (ADR-0174 D7): every
/// channel operation is a cancellation point that observes the ambient scope
/// context. Each forwards to the token form; the split exists so the emitter
/// passes the hidden context parameter straight through.
shared partial class ChannelOps {
    /// Receives one value under [`context`](paramref); see (cref:Receive{T}(Channel{T},
    /// CancellationToken)).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param context The ambient context.
    /// @returns The received value, or the zero value when closed and drained.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Receive[T](channel Channel[T]?, context Context?) T -> Receive(
        channel,
        context?.Token ?? default(CancellationToken)
    )

    /// Receives one value from a reader under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param context The ambient context.
    /// @returns The received value, or the zero value when closed and drained.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Receive[T](reader ChannelReader[T]?, context Context?) T -> Receive(
        reader,
        context?.Token ?? default(CancellationToken)
    )

    /// The two-value receive under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param context The ambient context.
    /// @returns The value and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Receive2[T](channel Channel[T]?, context Context?)(Value T, Ok bool) -> Receive2(
        channel,
        context?.Token ?? default(CancellationToken)
    )

    /// The two-value receive from a reader under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param context The ambient context.
    /// @returns The value and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Receive2[T](reader ChannelReader[T]?, context Context?)(Value T, Ok bool) -> Receive2(
        reader,
        context?.Token ?? default(CancellationToken)
    )

    /// Sends one value under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param value The value.
    /// @param context The ambient context.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Send[T](channel Channel[T]?, value T, context Context?) -> Send(
        channel,
        value,
        context?.Token ?? default(CancellationToken)
    )

    /// Sends one value through a writer under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param writer The writer, or `nil`.
    /// @param value The value.
    /// @param context The ambient context.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Send[T](writer ChannelWriter[T]?, value T, context Context?) -> Send(
        writer,
        value,
        context?.Token ?? default(CancellationToken)
    )

    /// The suspending receive under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param context The ambient context.
    /// @returns The value and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveAsync[T](channel Channel[T]?, context Context?) ValueTask[ReceiveResult[T]] -> ReceiveAsync(
        channel,
        context?.Token ?? default(CancellationToken)
    )

    /// The suspending receive from a reader under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param context The ambient context.
    /// @returns The value and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveAsync[T](reader ChannelReader[T]?, context Context?) ValueTask[ReceiveResult[T]] -> ReceiveAsync(
        reader,
        context?.Token ?? default(CancellationToken)
    )

    /// The suspending send under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param value The value.
    /// @param context The ambient context.
    /// @returns A task that completes when the value has been accepted.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func SendAsync[T](channel Channel[T]?, value T, context Context?) ValueTask -> SendAsync(
        channel,
        value,
        context?.Token ?? default(CancellationToken)
    )

    /// The suspending send through a writer under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param writer The writer, or `nil`.
    /// @param value The value.
    /// @param context The ambient context.
    /// @returns A task that completes when the value has been accepted.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func SendAsync[T](writer ChannelWriter[T]?, value T, context Context?) ValueTask -> SendAsync(
        writer,
        value,
        context?.Token ?? default(CancellationToken)
    )
}
