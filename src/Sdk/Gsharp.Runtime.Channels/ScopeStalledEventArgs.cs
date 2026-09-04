// <copyright file="ScopeStalledEventArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Reports that a <c>scope</c>'s join has been waiting longer than
/// <see cref="GsharpRuntime.ScopeStallTimeout"/> (ADR-0174 D6). The join
/// continues; this is a diagnostic, not an abort.
/// </summary>
public sealed class ScopeStalledEventArgs : EventArgs
{
    /// <summary>Initializes a new instance of the <see cref="ScopeStalledEventArgs"/> class.</summary>
    /// <param name="waited">How long the join has been waiting.</param>
    /// <param name="pendingGoroutines">How many registrations are still outstanding.</param>
    public ScopeStalledEventArgs(TimeSpan waited, int pendingGoroutines)
    {
        Waited = waited;
        PendingGoroutines = pendingGoroutines;
    }

    /// <summary>Gets how long the join had been waiting when the stall was reported.</summary>
    public TimeSpan Waited { get; }

    /// <summary>Gets the number of goroutines the scope was still waiting for.</summary>
    public int PendingGoroutines { get; }
}
