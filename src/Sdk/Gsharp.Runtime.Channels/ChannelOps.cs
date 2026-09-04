// <copyright file="ChannelOps.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The static facade the G# compiler emits channel operations against
/// (ADR-0174 D1/D2). One call per operation; the fast-path/fallback dispatch
/// — <see cref="Chan{T}"/> versus a foreign BCL <see cref="Channel{T}"/>,
/// <see cref="ChannelReader{T}"/>, or <see cref="ChannelWriter{T}"/> — lives
/// here in tested C# rather than in emitted IL.
/// </summary>
/// <remarks>
/// <para>The blocking forms (<see cref="Receive{T}(Channel{T}, CancellationToken)"/>
/// and friends) exist for the Phase 2 lowering, which still blocks a thread
/// per parked operation; Phase 3 replaces them with the <c>…Async</c> forms
/// and deletes them. Blocking on an incomplete <c>IValueTaskSource</c>-backed
/// <see cref="ValueTask"/> is unsupported, so every blocking form goes through
/// <c>AsTask()</c> only after the non-blocking fast path has failed.</para>
/// <para>A <c>nil</c> channel blocks forever — Go parity, and what makes a
/// disabled <c>select</c> arm work. A foreign reader's fallback is the
/// <c>WaitToReadAsync</c> → <c>TryRead</c> <em>loop</em>: readiness does not
/// reserve an item, so a competing consumer may take it first. A faulted
/// foreign completion propagates as the thrown fault rather than as an
/// ordinary close.</para>
/// </remarks>
public static partial class ChannelOps
{
    /// <summary>Receives one value, blocking the thread while none is available. The zero value on a closed channel — without an exception.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The received value, or the zero value when closed and drained.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T Receive<T>(Channel<T>? channel, CancellationToken cancellationToken)
        => Receive2(channel, cancellationToken).Value;

    /// <summary>Receives one value from a reader, blocking the thread while none is available.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The received value, or the zero value when closed and drained.</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static T Receive<T>(ChannelReader<T>? reader, CancellationToken cancellationToken)
        => Receive2(reader, cancellationToken).Value;

    /// <summary>The two-value receive <c>let v, ok = &lt;-ch</c>, blocking the thread while nothing is available.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The value and whether one was delivered.</returns>
    public static (T Value, bool Ok) Receive2<T>(Channel<T>? channel, CancellationToken cancellationToken)
    {
        if (channel is Chan<T> chan)
        {
            if (chan.TryReceive(out var value, out var ok))
            {
                // The pair IS the three-state encoding (ADR-0174 D3): a null
                // `value` is meaningful here and `ok` tells the caller so.
                return (value!, ok);
            }

            return Block(chan.ReceiveAsync(cancellationToken)).ToTuple();
        }

        return Receive2(channel?.Reader, cancellationToken);
    }

    /// <summary>The two-value receive from a reader, blocking the thread while nothing is available.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The value and whether one was delivered.</returns>
    public static (T Value, bool Ok) Receive2<T>(ChannelReader<T>? reader, CancellationToken cancellationToken)
    {
        if (reader is Chan<T>.ChanReader owned)
        {
            return Receive2(owned.Owner, cancellationToken);
        }

        if (reader is null)
        {
            BlockForever(cancellationToken);
        }

        // D2's fallback loop: WaitToReadAsync completing does not reserve an
        // item, so a competing consumer can take it first. Repeat.
        while (true)
        {
            if (reader.TryRead(out var value))
            {
                return (value, true);
            }

            if (!Block(reader.WaitToReadAsync(cancellationToken)))
            {
                return (default!, false);
            }
        }
    }

    /// <summary>Sends a value, blocking the thread until it is buffered or taken.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="value">The value to send.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <exception cref="ChannelClosedException">The channel is closed.</exception>
    public static void Send<T>(Channel<T>? channel, T value, CancellationToken cancellationToken)
    {
        if (channel is Chan<T> chan)
        {
            if (!chan.TrySend(value))
            {
                Block(chan.SendAsync(value, cancellationToken));
            }

            return;
        }

        Send(channel?.Writer, value, cancellationToken);
    }

    /// <summary>Sends a value through a writer, blocking the thread until it is buffered or taken.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The writer, or <c>nil</c>.</param>
    /// <param name="value">The value to send.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <exception cref="ChannelClosedException">The channel is closed.</exception>
    public static void Send<T>(ChannelWriter<T>? writer, T value, CancellationToken cancellationToken)
    {
        if (writer is Chan<T>.ChanWriter owned)
        {
            Send(owned.Owner, value, cancellationToken);
            return;
        }

        if (writer is null)
        {
            BlockForever(cancellationToken);
        }

        if (!writer.TryWrite(value))
        {
            Block(writer.WriteAsync(value, cancellationToken));
        }
    }

    /// <summary>Receives one value, parking without a thread while none is available.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The value and whether one was delivered (false: closed and drained).</returns>
    public static ValueTask<ReceiveResult<T>> ReceiveAsync<T>(Channel<T>? channel, CancellationToken cancellationToken)
    {
        if (channel is Chan<T> chan)
        {
            return chan.ReceiveAsync(cancellationToken);
        }

        return ReceiveAsync(channel?.Reader, cancellationToken);
    }

    /// <summary>Receives one value from a reader, parking without a thread while none is available.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, or <c>nil</c>.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>The value and whether one was delivered (false: closed and drained).</returns>
    public static ValueTask<ReceiveResult<T>> ReceiveAsync<T>(ChannelReader<T>? reader, CancellationToken cancellationToken)
    {
        if (reader is Chan<T>.ChanReader owned)
        {
            return owned.Owner.ReceiveAsync(cancellationToken);
        }

        if (reader is null)
        {
            return NeverAsync<ReceiveResult<T>>(cancellationToken);
        }

        if (reader.TryRead(out var value))
        {
            return new ValueTask<ReceiveResult<T>>(new ReceiveResult<T>(value, true));
        }

        return ForeignReceiveSlowAsync(reader, cancellationToken);
    }

    /// <summary>Sends a value, parking without a thread until it is buffered or taken.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel, or <c>nil</c>.</param>
    /// <param name="value">The value to send.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>A task that completes when the send commits.</returns>
    public static ValueTask SendAsync<T>(Channel<T>? channel, T value, CancellationToken cancellationToken)
    {
        if (channel is Chan<T> chan)
        {
            return chan.SendAsync(value, cancellationToken);
        }

        return SendAsync(channel?.Writer, value, cancellationToken);
    }

    /// <summary>Sends a value through a writer, parking without a thread until it is buffered or taken.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The writer, or <c>nil</c>.</param>
    /// <param name="value">The value to send.</param>
    /// <param name="cancellationToken">The ambient cancellation.</param>
    /// <returns>A task that completes when the send commits.</returns>
    public static ValueTask SendAsync<T>(ChannelWriter<T>? writer, T value, CancellationToken cancellationToken)
    {
        if (writer is Chan<T>.ChanWriter owned)
        {
            return owned.Owner.SendAsync(value, cancellationToken);
        }

        if (writer is null)
        {
            return new ValueTask(NeverAsync<bool>(cancellationToken).AsTask());
        }

        return writer.TryWrite(value) ? ValueTask.CompletedTask : writer.WriteAsync(value, cancellationToken);
    }

    /// <summary>
    /// Closes a channel: Go semantics (double close throws) for a
    /// <see cref="Chan{T}"/>; <c>TryComplete()</c> for a foreign channel, where
    /// a double close does not throw (documented in ADR-0174 D2's matrix).
    /// </summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel.</param>
    /// <exception cref="ChannelClosedException">A <see cref="Chan{T}"/> was already closed, or the channel is <c>nil</c>.</exception>
    public static void Close<T>(Channel<T>? channel)
    {
        switch (channel)
        {
            case Chan<T> chan:
                chan.Close();
                break;
            case null:
                throw new ChannelClosedException("close of nil channel");
            default:
                channel.Writer.TryComplete();
                break;
        }
    }

    /// <summary>Closes through a writer; see <see cref="Close{T}(Channel{T})"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The writer.</param>
    /// <exception cref="ChannelClosedException">A <see cref="Chan{T}"/> was already closed, or the writer is <c>nil</c>.</exception>
    public static void Close<T>(ChannelWriter<T>? writer)
    {
        switch (writer)
        {
            case Chan<T>.ChanWriter owned:
                owned.Owner.Close();
                break;
            case null:
                throw new ChannelClosedException("close of nil channel");
            default:
                writer.TryComplete();
                break;
        }
    }

    private static async ValueTask<ReceiveResult<T>> ForeignReceiveSlowAsync<T>(ChannelReader<T> reader, CancellationToken cancellationToken)
    {
        while (true)
        {
            if (!await reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return ReceiveResult<T>.Closed;
            }

            if (reader.TryRead(out var value))
            {
                return new ReceiveResult<T>(value, true);
            }
        }
    }

    private static async ValueTask<TResult> NeverAsync<TResult>(CancellationToken cancellationToken)
    {
        await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
        throw new OperationCanceledException(cancellationToken);
    }

    private static TResult Block<TResult>(ValueTask<TResult> pending)
        => pending.IsCompletedSuccessfully ? pending.Result : pending.AsTask().GetAwaiter().GetResult();

    private static void Block(ValueTask pending)
    {
        if (!pending.IsCompletedSuccessfully)
        {
            pending.AsTask().GetAwaiter().GetResult();
        }
    }

    [DoesNotReturn]
    private static void BlockForever(CancellationToken cancellationToken)
    {
        cancellationToken.WaitHandle.WaitOne();
        throw new OperationCanceledException(cancellationToken);
    }

    // The tuple IS the three-state encoding (ADR-0174 D3): the zero value
    // travels with `Ok` false, which is what the receiver deconstructs.
    private static (T Value, bool Ok) ToTuple<T>(this ReceiveResult<T> result) => (result.Value!, result.Ok);
}
