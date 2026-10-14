// <copyright file="ReceiveStart.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// How a suspending receive began, so the three result shapes of
/// (cref:Chan{T}) can share one start (issue #3902 S2).
internal enum ReceiveStart {
    Ready,
    Closed,
    Cancelled,
    Parked
}
