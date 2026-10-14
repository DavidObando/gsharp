// <copyright file="ChannelDirection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// The direction of a channel type clause (ADR-0174 D2): `chan[T]` is
/// bidirectional and binds to `Channel<T>`; `in chan[T]` is
/// receive-only and binds to `ChannelReader<T>`; `out chan[T]`
/// is send-only and binds to `ChannelWriter<T>`. The keywords are
/// the language's existing variance keywords: `in` is what you read
/// from, `out` is what you write to.
enum ChannelDirection {
    Both,
    In,
    Out
}
