// <copyright file="ChannelExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The member spelling of the retired <c>close(ch)</c> built-in (ADR-0174 D12):
/// <c>ch.Close()</c> on a <c>chan[T]</c> or <c>out chan[T]</c>. On a
/// <see cref="Chan{T}"/>-typed receiver the instance method wins; these
/// extensions serve the <c>Channel&lt;T&gt;</c>/<c>ChannelWriter&lt;T&gt;</c>-typed
/// handles. An <c>in chan[T]</c> (<see cref="ChannelReader{T}"/>) has no
/// <c>Close</c> at all — ordinary member-not-found, no bespoke diagnostic.
/// </summary>
public static class ChannelExtensions
{
    /// <summary>Closes the channel; Go semantics for a G# channel, <c>TryComplete()</c> for a foreign one.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="channel">The channel.</param>
    public static void Close<T>(this Channel<T> channel) => ChannelOps.Close(channel);

    /// <summary>Closes the channel behind a send-only handle.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="writer">The send-only handle.</param>
    public static void Close<T>(this ChannelWriter<T> writer) => ChannelOps.Close(writer);
}
