// <copyright file="SendOutcome.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// The outcome of a non-blocking send attempt.
internal enum SendOutcome {
    Sent,
    Full,
    Closed
}
