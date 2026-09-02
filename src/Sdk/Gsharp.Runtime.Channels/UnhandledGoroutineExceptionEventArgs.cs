// <copyright file="UnhandledGoroutineExceptionEventArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>The payload of <see cref="GoroutineRuntime.UnhandledGoroutineException"/>.</summary>
public sealed class UnhandledGoroutineExceptionEventArgs : EventArgs
{
    /// <summary>Initializes a new instance of the <see cref="UnhandledGoroutineExceptionEventArgs"/> class.</summary>
    /// <param name="exception">The free goroutine's failure.</param>
    public UnhandledGoroutineExceptionEventArgs(Exception exception)
    {
        Exception = exception;
    }

    /// <summary>Gets the free goroutine's failure, unwrapped.</summary>
    public Exception Exception { get; }

    /// <summary>Gets or sets a value indicating whether a subscriber has taken responsibility for the failure. When it stays <see langword="false"/> the process terminates.</summary>
    public bool Handled { get; set; }
}
