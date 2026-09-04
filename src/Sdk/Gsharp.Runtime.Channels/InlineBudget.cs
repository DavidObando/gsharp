// <copyright file="InlineBudget.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;

namespace Gsharp.Concurrency;

/// <summary>
/// Decides whether a hand-off may complete its waiter's continuation INLINE, on
/// the publishing thread, instead of queueing it to the thread pool
/// (ADR-0174 gate G6, issue #3902 H1).
/// </summary>
/// <remarks>
/// <para>
/// A parked receive costs one thread-pool work item per hand-off: the publisher
/// queues, another pool thread steals. That hop is most of what separates a G#
/// rendezvous from Go's, where <c>goready</c> hands the receiver straight to the
/// scheduler. Completing inline removes it — at the price of running the
/// receiver's continuation on the sender's stack, which is why this is a
/// budget rather than a switch.
/// </para>
/// <para>
/// Two things bound it. <b>Depth</b>: a chain of rendezvous hand-offs would
/// otherwise nest one frame per link, so past <see cref="Limit"/> the hop comes
/// back and the stack unwinds. <b>Stack</b>:
/// <see cref="RuntimeHelpers.TryEnsureSufficientExecutionStack"/> is consulted
/// every time, so a deep user stack declines before it overflows rather than
/// after.
/// </para>
/// <para>
/// <b>Suppression is the correctness half.</b> Inline publication is only safe
/// where the publisher holds no lock the continuation could re-enter. G#'s
/// blocking channel forms are what <c>lock { ch &lt;- v }</c> compiles to, and
/// Monitor is reentrant: an inline receiver would run INSIDE the sender's
/// monitor and observe mutual exclusion it does not have. Those paths, and
/// cancellation callbacks, publish under <see cref="Suppress"/>.
/// </para>
/// </remarks>
internal static class InlineBudget
{
    /// <summary>
    /// The default nesting limit. Sixteen is deep enough that a hand-off chain
    /// almost never pays the hop and shallow enough to be irrelevant against
    /// any real stack; the environment variable exists to measure the ends.
    /// </summary>
    private const int DefaultLimit = 16;

    [ThreadStatic]
    private static int depth;

    [ThreadStatic]
    private static int suppressions;

    /// <summary>Gets the nesting limit; <c>GS_INLINE_DEPTH=0</c> restores the always-queue behaviour.</summary>
    internal static int Limit { get; } =
        int.TryParse(Environment.GetEnvironmentVariable("GS_INLINE_DEPTH"), out var configured) && configured >= 0
            ? configured
            : DefaultLimit;

    /// <summary>Takes an inline slot when one is available.</summary>
    /// <returns>True when the caller may publish inline, and must then call <see cref="Exit"/>.</returns>
    internal static bool TryEnter()
    {
        if (suppressions > 0 || depth >= Limit || !RuntimeHelpers.TryEnsureSufficientExecutionStack())
        {
            return false;
        }

        depth++;
        return true;
    }

    /// <summary>Releases a slot taken by <see cref="TryEnter"/>.</summary>
    internal static void Exit() => depth--;

    /// <summary>
    /// Forbids inline publication for the duration of the returned scope. Used
    /// where the publisher holds a lock, or is running inside a cancellation
    /// callback, and must not run a continuation on its own stack.
    /// </summary>
    /// <returns>A scope that restores the previous state.</returns>
    internal static Scope Suppress() => new Scope();

    /// <summary>The suppression scope; see <see cref="Suppress"/>.</summary>
    internal readonly struct Scope : IDisposable
    {
        /// <summary>Initializes a new instance of the <see cref="Scope"/> struct.</summary>
        public Scope() => suppressions++;

        /// <inheritdoc/>
        public void Dispose() => suppressions--;
    }
}
