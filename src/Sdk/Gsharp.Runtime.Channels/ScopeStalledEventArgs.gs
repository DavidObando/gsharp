// <copyright file="ScopeStalledEventArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System

/// Reports that a `scope`'s join has been waiting longer than
/// (cref:GsharpRuntime.ScopeStallTimeout) (ADR-0174 D6). The join
/// continues; this is a diagnostic, not an abort.
class ScopeStalledEventArgs : EventArgs {
    /// Initializes a new instance of the (cref:ScopeStalledEventArgs) class.
    /// @param waited How long the join has been waiting.
    /// @param pendingGoroutines How many registrations are still outstanding.
    init(waited TimeSpan, pendingGoroutines int32) {
        Waited = waited
        PendingGoroutines = pendingGoroutines
    }

    /// Gets how long the join had been waiting when the stall was reported.
    prop Waited TimeSpan {
        get;
    }

    /// Gets the number of goroutines the scope was still waiting for.
    prop PendingGoroutines int32 {
        get;
    }
}
