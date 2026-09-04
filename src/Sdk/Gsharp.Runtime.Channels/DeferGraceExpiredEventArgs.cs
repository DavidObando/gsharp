// <copyright file="DeferGraceExpiredEventArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// Reports that a <c>defer</c> body outlived its shielded grace budget and was
/// abandoned (ADR-0174 D7).
/// </summary>
public sealed class DeferGraceExpiredEventArgs : EventArgs
{
    /// <summary>Initializes a new instance of the <see cref="DeferGraceExpiredEventArgs"/> class.</summary>
    /// <param name="budget">The budget that expired.</param>
    public DeferGraceExpiredEventArgs(TimeSpan budget) => Budget = budget;

    /// <summary>Gets the grace budget that expired.</summary>
    public TimeSpan Budget { get; }
}
