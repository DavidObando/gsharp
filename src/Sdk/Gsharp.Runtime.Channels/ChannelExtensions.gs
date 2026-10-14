// <copyright file="ChannelExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Threading.Channels

/// The member spelling of the retired `close(ch)` built-in (ADR-0174 D12):
/// `ch.Close()` on a `chan[T]` or `out chan[T]`. On a
/// (cref:Chan{T})-typed receiver the instance method wins; these
/// extensions serve the `Channel<T>`/`ChannelWriter<T>`-typed
/// handles. An `in chan[T]` ((cref:ChannelReader{T})) has no
/// `Close` at all — ordinary member-not-found, no bespoke diagnostic.
shared class ChannelExtensions { }

/// Closes the channel; Go semantics for a G# channel, `TryComplete()` for a foreign one.
/// @typeparam T The element type.
@ExtensionOwner(typeof(ChannelExtensions))
func (channel Channel[T]) Close[T]() -> ChannelOps.Close(channel)

/// Closes the channel behind a send-only handle.
/// @typeparam T The element type.
@ExtensionOwner(typeof(ChannelExtensions))
func (writer ChannelWriter[T]) Close[T]() -> ChannelOps.Close(writer)
