// <copyright file="SendOutcome.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>The outcome of a non-blocking send attempt.</summary>
internal enum SendOutcome
{
    /// <summary>The value was buffered or handed to a receiver.</summary>
    Sent,

    /// <summary>The buffer is full (or the channel is rendezvous with no receiver parked).</summary>
    Full,

    /// <summary>The channel is closed.</summary>
    Closed,
}
