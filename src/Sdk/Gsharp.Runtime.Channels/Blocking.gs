// <copyright file="Blocking.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Threading.Tasks

/// The root boundary between suspending and non-suspending code (ADR-0174
/// D4). A G# call site inside a non-suspending, non-`async` function that
/// invokes a `suspend func` has nowhere to await, so the compiler emits a
/// call through here and warns (GS0558): the thread blocks until the callee
/// completes. The synthesized entry point is the one place this is the right
/// thing; everywhere else the fix is to let the caller suspend too.
shared class Blocking {
    /// Blocks until [`pending`](paramref) completes and returns its result.
    /// @typeparam T The result type.
    /// @param pending The suspending call's task.
    /// @returns The result.
    func Wait[T](pending ValueTask[T]) T {
        if pending.IsCompletedSuccessfully {
            return pending.Result
        }
        return pending.AsTask().GetAwaiter().GetResult()
    }

    /// Blocks until [`pending`](paramref) completes.
    /// @param pending The suspending call's task.
    func Wait(pending ValueTask) {
        if pending.IsCompletedSuccessfully {
            return
        }
        pending.AsTask().GetAwaiter().GetResult()
    }
}
