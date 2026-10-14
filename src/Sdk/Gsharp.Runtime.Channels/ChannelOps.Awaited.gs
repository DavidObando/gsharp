// <copyright file="ChannelOps.Awaited.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// The suspending receives shaped for an implicit `await` (ADR-0174 D4):
/// (cref:ReceiveValueAsync{T}(Channel{T}, CancellationToken)) yields the
/// element (its zero value once closed) and
/// (cref:ReceiveTupleAsync{T}(Channel{T}, CancellationToken)) the
/// `(T, bool)` of the two-value receive — so the compiler awaits one call
/// and reads no member of (cref:ReceiveResult{T}) in emitted IL. Both
/// complete synchronously when a value is ready and allocate nothing then.
///
/// Issue #3902 (S2): a G#-owned (cref:Chan{T}) — the overwhelmingly
/// common case — is shaped by the channel itself, so the parked path is backed
/// by the waiter node and allocates nothing either. Only a genuinely foreign
/// (cref:ChannelReader{T}) still goes through the reshaping wrappers
/// below, and those now use the pooling builder so their state machine is
/// rented rather than allocated.
shared partial class ChannelOps {
    /// Receives one value, suspending while none is available; the zero value once the channel is closed
    /// and drained.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil` (parks until cancelled).
    /// @param cancellationToken The ambient cancellation.
    /// @returns The element, or the zero value when closed.
    func ReceiveValueAsync[T](channel Channel[T]?, cancellationToken CancellationToken) ValueTask[
        T
    ] -> if channel is Chan[T]chan_ {
        chan_.ReceiveValueAsync(cancellationToken)
    } else {
        ReceiveValueAsync(channel?.Reader, cancellationToken)
    }

    /// Receives one value from a reader, suspending while none is available.
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil` (parks until cancelled).
    /// @param cancellationToken The ambient cancellation.
    /// @returns The element, or the zero value when closed.
    func ReceiveValueAsync[T](reader ChannelReader[T]?, cancellationToken CancellationToken) ValueTask[
        T
    ] -> if reader is Chan[T].ChanReader owned {
        owned.Owner.ReceiveValueAsync(cancellationToken)
    } else {
        Unwrap(ReceiveAsync(reader, cancellationToken))
    }

    /// The suspending two-value receive as a tuple.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil` (parks until cancelled).
    /// @param cancellationToken The ambient cancellation.
    /// @returns The element and whether the channel delivered it.
    func ReceiveTupleAsync[T](channel Channel[T]?, cancellationToken CancellationToken) ValueTask[
        (Value T, Ok bool)
    ] -> if channel is Chan[T]chan_ {
        chan_.ReceiveTupleAsync(cancellationToken)
    } else {
        ReceiveTupleAsync(channel?.Reader, cancellationToken)
    }

    /// The suspending two-value receive from a reader as a tuple.
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil` (parks until cancelled).
    /// @param cancellationToken The ambient cancellation.
    /// @returns The element and whether the channel delivered it.
    func ReceiveTupleAsync[T](reader ChannelReader[T]?, cancellationToken CancellationToken) ValueTask[
        (Value T, Ok bool)
    ] -> if reader is Chan[T].ChanReader owned {
        owned.Owner.ReceiveTupleAsync(cancellationToken)
    } else {
        ToTuple(ReceiveAsync(reader, cancellationToken))
    }

    /// Receives one value under [`context`](paramref); see (cref:ReceiveValueAsync{T}(Channel{T},
    /// CancellationToken)).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param context The ambient context.
    /// @returns The element, or the zero value when closed.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveValueAsync[T](channel Channel[T]?, context Context?) ValueTask[T] -> ReceiveValueAsync(
        channel,
        context?.Token ?? default(CancellationToken)
    )

    /// Receives one value from a reader under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param context The ambient context.
    /// @returns The element, or the zero value when closed.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveValueAsync[T](reader ChannelReader[T]?, context Context?) ValueTask[T] -> ReceiveValueAsync(
        reader,
        context?.Token ?? default(CancellationToken)
    )

    /// The suspending two-value receive under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param context The ambient context.
    /// @returns The element and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveTupleAsync[T](channel Channel[T]?, context Context?) ValueTask[(Value T, Ok bool)] -> ReceiveTupleAsync(
        channel,
        context?.Token ?? default(CancellationToken)
    )

    /// The suspending two-value receive from a reader under [`context`](paramref).
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param context The ambient context.
    /// @returns The element and whether the channel delivered it.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func ReceiveTupleAsync[T](reader ChannelReader[T]?, context Context?) ValueTask[
        (Value T, Ok bool)
    ] -> ReceiveTupleAsync(reader, context?.Token ?? default(CancellationToken))

    private func Unwrap[T](pending ValueTask[ReceiveResult[T]]) ValueTask[T] {
        let Awaited = async func (pending ValueTask[ReceiveResult[T]]) ValueTask[T] {
            let result = await pending.ConfigureAwait(false)
            // As above: the zero value is the documented closed-channel result.
            return result.Element
        }
        if pending.IsCompletedSuccessfully {
            // A single-value receive yields the zero value on a closed
            // channel by design (ADR-0174 D3); there is no null to guard.
            return ValueTask[T](pending.Result.Element)
        }
        return Awaited(pending)
    }

    private func ToTuple[T](pending ValueTask[ReceiveResult[T]]) ValueTask[(Value T, Ok bool)] {
        let Awaited = async func (pending ValueTask[ReceiveResult[T]]) ValueTask[(Value T, Ok bool)] {
            let result = await pending.ConfigureAwait(false)
            // The tuple IS the three-state encoding (ADR-0174 D3).
            return (result.Element, result.Ok)
        }
        if pending.IsCompletedSuccessfully {
            let result = pending.Result
            // The tuple IS the three-state encoding (ADR-0174 D3).
            return ValueTask[(Value T, Ok bool)]((result.Element, result.Ok))
        }
        return Awaited(pending)
    }
}
