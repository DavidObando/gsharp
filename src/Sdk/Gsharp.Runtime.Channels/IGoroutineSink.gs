// <copyright file="IGoroutineSink.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System

/// The exactly-one completion sink every goroutine reports to (ADR-0174 D5).
/// A scoped goroutine's sink is its (cref:ScopeFrame); a free one's is
/// (cref:GoroutineRuntime.FreeSink). The work item calls
/// (cref:Register) before it is queued and exactly one of
/// (cref:Complete) or (cref:Fail) when the body's
/// (cref:ValueTask) has been consumed.
interface IGoroutineSink {
    /// Gets the ambient cancellation context the goroutine body runs under.
    prop Context Context {
        get;
    }

    /// Records that a goroutine is about to be queued. Called before `UnsafeQueueUserWorkItem`, never
    /// after.
    func Register();

    /// Records that a registered goroutine ran to completion.
    func Complete();

    /// Records that a registered goroutine faulted.
    /// @param exception The body's exception, unwrapped.
    func Fail(exception Exception);
}
