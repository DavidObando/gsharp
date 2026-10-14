// <copyright file="ChannelOps.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Diagnostics.CodeAnalysis
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Channels
import System.Threading.Tasks

/// The static facade the G# compiler emits channel operations against
/// (ADR-0174 D1/D2). One call per operation; the fast-path/fallback dispatch
/// — (cref:Chan{T}) versus a foreign BCL (cref:Channel{T}),
/// (cref:ChannelReader{T}), or (cref:ChannelWriter{T}) — lives
/// here in tested C# rather than in emitted IL.
/// @remarks The blocking forms ((cref:Receive{T}(Channel{T}, CancellationToken))
/// and friends) exist for the Phase 2 lowering, which still blocks a thread
/// per parked operation; Phase 3 replaces them with the `…Async` forms
/// and deletes them. Blocking on an incomplete `IValueTaskSource`-backed
/// (cref:ValueTask) is unsupported, so every blocking form goes through
/// `AsTask()` only after the non-blocking fast path has failed.
///
/// A `nil` channel blocks forever — Go parity, and what makes a
/// disabled `select` arm work. A foreign reader's fallback is the
/// `WaitToReadAsync` → `TryRead` <em>loop</em>: readiness does not
/// reserve an item, so a competing consumer may take it first. A faulted
/// foreign completion propagates as the thrown fault rather than as an
/// ordinary close.
shared partial class ChannelOps {
    /// Receives one value, blocking the thread while none is available. The zero value on a closed channel
    /// — without an exception.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The received value, or the zero value when closed and drained.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Receive[T](channel Channel[T]?, cancellationToken CancellationToken) T -> Receive2(
        channel,
        cancellationToken
    ).Value

    /// Receives one value from a reader, blocking the thread while none is available.
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The received value, or the zero value when closed and drained.
    @MethodImpl(MethodImplOptions.AggressiveInlining)
    func Receive[T](reader ChannelReader[T]?, cancellationToken CancellationToken) T -> Receive2(
        reader,
        cancellationToken
    ).Value

    /// The two-value receive `let v, ok = <-ch`, blocking the thread while nothing is available.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The value and whether one was delivered.
    func Receive2[T](channel Channel[T]?, cancellationToken CancellationToken)(Value T, Ok bool) {
        // Issue #3902 H1: a blocking channel operation is what the body of a
        // `lock { ch <- v }` compiles to (ADR-0174 errata 10). Monitor is
        // reentrant, so an inline continuation would run INSIDE the caller's
        // lock and observe mutual exclusion it does not hold. Publication on
        // these paths always queues.
        using let noInline = InlineBudget.Suppress()
        if channel is Chan[T]chan_ {
            if chan_.TryReceive(out var value, out var ok) {
                // The pair IS the three-state encoding (ADR-0174 D3): a null
                // `value` is meaningful here and `ok` tells the caller so.
                let delivered = ReceiveResult[T](value, ok)
                return (delivered.Element, delivered.Ok)
            }
            return Block(chan_.ReceiveAsync(cancellationToken)).ToTuple()
        }
        return Receive2(channel?.Reader, cancellationToken)
    }

    /// The two-value receive from a reader, blocking the thread while nothing is available.
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The value and whether one was delivered.
    func Receive2[T](reader ChannelReader[T]?, cancellationToken CancellationToken)(Value T, Ok bool) {
        // Issue #3902 H1: a blocking channel operation is what the body of a
        // `lock { ch <- v }` compiles to (ADR-0174 errata 10). Monitor is
        // reentrant, so an inline continuation would run INSIDE the caller's
        // lock and observe mutual exclusion it does not hold. Publication on
        // these paths always queues.
        using let noInline = InlineBudget.Suppress()
        if reader is Chan[T].ChanReader owned {
            return Receive2(owned.Owner, cancellationToken)
        }
        if reader == nil {
            BlockForever(cancellationToken)
        }
        // D2's fallback loop: WaitToReadAsync completing does not reserve an
        // item, so a competing consumer can take it first. Repeat.
        while true {
            if reader!!.TryRead(out var value) {
                return (value, true)
            }
            if !Block(reader!!.WaitToReadAsync(cancellationToken)) {
                return (ReceiveResult[T].ZeroValue(), false)
            }
        }
    }

    /// Sends a value, blocking the thread until it is buffered or taken.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param value The value to send.
    /// @param cancellationToken The ambient cancellation.
    /// @exception ChannelClosedException The channel is closed.
    func Send[T](channel Channel[T]?, value T, cancellationToken CancellationToken) {
        // Issue #3902 H1: a blocking channel operation is what the body of a
        // `lock { ch <- v }` compiles to (ADR-0174 errata 10). Monitor is
        // reentrant, so an inline continuation would run INSIDE the caller's
        // lock and observe mutual exclusion it does not hold. Publication on
        // these paths always queues.
        using let noInline = InlineBudget.Suppress()
        if channel is Chan[T]chan_ {
            if !chan_.TrySend(value) {
                Block(chan_.SendAsync(value, cancellationToken))
            }
            return
        }
        Send(channel?.Writer, value, cancellationToken)
    }

    /// Sends a value through a writer, blocking the thread until it is buffered or taken.
    /// @typeparam T The element type.
    /// @param writer The writer, or `nil`.
    /// @param value The value to send.
    /// @param cancellationToken The ambient cancellation.
    /// @exception ChannelClosedException The channel is closed.
    func Send[T](writer ChannelWriter[T]?, value T, cancellationToken CancellationToken) {
        // Issue #3902 H1: a blocking channel operation is what the body of a
        // `lock { ch <- v }` compiles to (ADR-0174 errata 10). Monitor is
        // reentrant, so an inline continuation would run INSIDE the caller's
        // lock and observe mutual exclusion it does not hold. Publication on
        // these paths always queues.
        using let noInline = InlineBudget.Suppress()
        if writer is Chan[T].ChanWriter owned {
            Send(owned.Owner, value, cancellationToken)
            return
        }
        if writer == nil {
            BlockForever(cancellationToken)
        }
        if !writer!!.TryWrite(value) {
            Block(writer!!.WriteAsync(value, cancellationToken))
        }
    }

    /// Receives one value, parking without a thread while none is available.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The value and whether one was delivered (false: closed and drained).
    func ReceiveAsync[T](channel Channel[T]?, cancellationToken CancellationToken) ValueTask[ReceiveResult[T]] {
        if channel is Chan[T]chan_ {
            return chan_.ReceiveAsync(cancellationToken)
        }
        return ReceiveAsync(channel?.Reader, cancellationToken)
    }

    /// Receives one value from a reader, parking without a thread while none is available.
    /// @typeparam T The element type.
    /// @param reader The reader, or `nil`.
    /// @param cancellationToken The ambient cancellation.
    /// @returns The value and whether one was delivered (false: closed and drained).
    func ReceiveAsync[T](reader ChannelReader[T]?, cancellationToken CancellationToken) ValueTask[ReceiveResult[T]] {
        if reader is Chan[T].ChanReader owned {
            return owned.Owner.ReceiveAsync(cancellationToken)
        }
        if reader == nil {
            return NeverAsync[ReceiveResult[T]](cancellationToken)
        }
        if reader.TryRead(out var value) {
            return ValueTask[ReceiveResult[T]](ReceiveResult[T](value, true))
        }
        return ForeignReceiveSlowAsync(reader, cancellationToken)
    }

    /// Sends a value, parking without a thread until it is buffered or taken.
    /// @typeparam T The element type.
    /// @param channel The channel, or `nil`.
    /// @param value The value to send.
    /// @param cancellationToken The ambient cancellation.
    /// @returns A task that completes when the send commits.
    func SendAsync[T](channel Channel[T]?, value T, cancellationToken CancellationToken) ValueTask {
        if channel is Chan[T]chan_ {
            return chan_.SendAsync(value, cancellationToken)
        }
        return SendAsync(channel?.Writer, value, cancellationToken)
    }

    /// Sends a value through a writer, parking without a thread until it is buffered or taken.
    /// @typeparam T The element type.
    /// @param writer The writer, or `nil`.
    /// @param value The value to send.
    /// @param cancellationToken The ambient cancellation.
    /// @returns A task that completes when the send commits.
    func SendAsync[T](writer ChannelWriter[T]?, value T, cancellationToken CancellationToken) ValueTask {
        if writer is Chan[T].ChanWriter owned {
            return owned.Owner.SendAsync(value, cancellationToken)
        }
        if writer == nil {
            return ValueTask(NeverAsync[bool](cancellationToken).AsTask())
        }
        return if writer.TryWrite(value) {
            ValueTask.CompletedTask
        } else {
            writer.WriteAsync(value, cancellationToken)
        }
    }

    /// Closes a channel: Go semantics (double close throws) for a
    /// (cref:Chan{T}); `TryComplete()` for a foreign channel, where
    /// a double close does not throw (documented in ADR-0174 D2's matrix).
    /// @typeparam T The element type.
    /// @param channel The channel.
    /// @exception ChannelClosedException A (cref:Chan{T}) was already closed, or the channel is `nil`.
    func Close[T](channel Channel[T]?) {
        switch channel {
            case chan_ is Chan[T] {
                chan_.Close()
            }
            case nil {
                throw ChannelClosedException("close of nil channel")
            }
            default {
                channel!!.Writer.TryComplete()
            }
        }
    }

    /// Closes through a writer; see (cref:Close{T}(Channel{T})).
    /// @typeparam T The element type.
    /// @param writer The writer.
    /// @exception ChannelClosedException A (cref:Chan{T}) was already closed, or the writer is `nil`.
    func Close[T](writer ChannelWriter[T]?) {
        switch writer {
            case owned is Chan[T].ChanWriter {
                owned.Owner.Close()
            }
            case nil {
                throw ChannelClosedException("close of nil channel")
            }
            default {
                writer!!.TryComplete()
            }
        }
    }

    private async func ForeignReceiveSlowAsync[T](
        reader ChannelReader[T],
        cancellationToken CancellationToken
    ) ValueTask[ReceiveResult[T]] {
        while true {
            if !await reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false) {
                return ReceiveResult[T].Closed
            }
            if reader.TryRead(out var value) {
                return ReceiveResult[T](value, true)
            }
        }
    }

    private async func NeverAsync[TResult](cancellationToken CancellationToken) ValueTask[TResult] {
        await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false)
        throw OperationCanceledException(cancellationToken)
    }

    private func Block[TResult](pending ValueTask[TResult]) TResult -> if pending.IsCompletedSuccessfully {
        pending.Result
    } else {
        pending.AsTask().GetAwaiter().GetResult()
    }

    private func Block(pending ValueTask) {
        if !pending.IsCompletedSuccessfully {
            pending.AsTask().GetAwaiter().GetResult()
        }
    }

    @DoesNotReturn
    private func BlockForever(cancellationToken CancellationToken) {
        cancellationToken.WaitHandle.WaitOne()
        throw OperationCanceledException(cancellationToken)
    }
}

// The tuple IS the three-state encoding (ADR-0174 D3): the zero value
// travels with `Ok` false, which is what the receiver deconstructs.
@ExtensionOwner(typeof(ChannelOps))
private func (result ReceiveResult[T]) ToTuple[T]()(Value T, Ok bool) -> (result.Element, result.Ok)
