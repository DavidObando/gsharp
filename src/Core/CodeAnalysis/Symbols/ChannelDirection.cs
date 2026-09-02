// <copyright file="ChannelDirection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The direction of a channel type clause (ADR-0174 D2): <c>chan[T]</c> is
/// bidirectional and binds to <c>Channel&lt;T&gt;</c>; <c>in chan[T]</c> is
/// receive-only and binds to <c>ChannelReader&lt;T&gt;</c>; <c>out chan[T]</c>
/// is send-only and binds to <c>ChannelWriter&lt;T&gt;</c>. The keywords are
/// the language's existing variance keywords: <c>in</c> is what you read
/// from, <c>out</c> is what you write to.
/// </summary>
public enum ChannelDirection
{
    /// <summary><c>chan[T]</c> — send and receive.</summary>
    Both,

    /// <summary><c>in chan[T]</c> — receive-only (<c>ChannelReader&lt;T&gt;</c>).</summary>
    In,

    /// <summary><c>out chan[T]</c> — send-only (<c>ChannelWriter&lt;T&gt;</c>).</summary>
    Out,
}
