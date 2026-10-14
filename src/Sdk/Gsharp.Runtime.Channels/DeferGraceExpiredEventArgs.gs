// <copyright file="DeferGraceExpiredEventArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System

/// Reports that a `defer` body outlived its shielded grace budget and was
/// abandoned (ADR-0174 D7).
class DeferGraceExpiredEventArgs : EventArgs {
    /// Initializes a new instance of the (cref:DeferGraceExpiredEventArgs) class.
    /// @param budget The budget that expired.
    init(budget TimeSpan) {
        Budget = budget
    }

    /// Gets the grace budget that expired.
    prop Budget TimeSpan {
        get;
    }
}
