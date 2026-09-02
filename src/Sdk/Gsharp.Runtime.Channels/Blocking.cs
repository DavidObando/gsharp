// <copyright file="Blocking.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The root boundary between suspending and non-suspending code (ADR-0174
/// D4). A G# call site inside a non-suspending, non-<c>async</c> function that
/// invokes a <c>suspend func</c> has nowhere to await, so the compiler emits a
/// call through here and warns (GS0558): the thread blocks until the callee
/// completes. The synthesized entry point is the one place this is the right
/// thing; everywhere else the fix is to let the caller suspend too.
/// </summary>
public static class Blocking
{
    /// <summary>Blocks until <paramref name="pending"/> completes and returns its result.</summary>
    /// <typeparam name="T">The result type.</typeparam>
    /// <param name="pending">The suspending call's task.</param>
    /// <returns>The result.</returns>
    public static T Wait<T>(ValueTask<T> pending)
    {
        if (pending.IsCompletedSuccessfully)
        {
            return pending.Result;
        }

        return pending.AsTask().GetAwaiter().GetResult();
    }

    /// <summary>Blocks until <paramref name="pending"/> completes.</summary>
    /// <param name="pending">The suspending call's task.</param>
    public static void Wait(ValueTask pending)
    {
        if (pending.IsCompletedSuccessfully)
        {
            return;
        }

        pending.AsTask().GetAwaiter().GetResult();
    }
}
