// <copyright file="UnhandledGoroutineExceptionEventArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System

/// The payload of (cref:GoroutineRuntime.UnhandledGoroutineException).
class UnhandledGoroutineExceptionEventArgs : EventArgs {
    /// Initializes a new instance of the (cref:UnhandledGoroutineExceptionEventArgs) class.
    /// @param exception The free goroutine's failure.
    init(exception Exception) {
        Exception = exception
    }

    /// Gets the free goroutine's failure, unwrapped.
    prop Exception Exception {
        get;
    }

    /// Gets or sets a value indicating whether a subscriber has taken responsibility for the failure. When
    /// it stays `false` the process terminates.
    prop Handled bool
}
