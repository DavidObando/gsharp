// <copyright file="ReceiveStart.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// How a suspending receive began, so the three result shapes of
/// <see cref="Chan{T}"/> can share one start (issue #3902 S2).
/// </summary>
internal enum ReceiveStart
{
    /// <summary>A value was available and taken without parking.</summary>
    Ready,

    /// <summary>The channel is closed and drained; no value will ever arrive.</summary>
    Closed,

    /// <summary>Cancellation was already requested when the receive would have parked.</summary>
    Cancelled,

    /// <summary>A node was parked; the result arrives through it.</summary>
    Parked,
}
