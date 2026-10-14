// <copyright file="InlineBudget.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Runtime.CompilerServices
import System.Threading

/// Decides whether a hand-off may complete its waiter's continuation INLINE, on
/// the publishing thread, instead of queueing it to the thread pool
/// (ADR-0174 gate G6, issue #3902 H1).
/// @remarks A parked receive costs one thread-pool work item per hand-off: the publisher
/// queues, another pool thread steals. That hop is most of what separates a G#
/// rendezvous from Go's, where `goready` hands the receiver straight to the
/// scheduler. Completing inline removes it — at the price of running the
/// receiver's continuation on the sender's stack, which is why this is a
/// budget rather than a switch.
///
/// Two things bound it. <b>Depth</b>: a chain of rendezvous hand-offs would
/// otherwise nest one frame per link, so past (cref:Limit) the hop comes
/// back and the stack unwinds. <b>Stack</b>:
/// (cref:RuntimeHelpers.TryEnsureSufficientExecutionStack) is consulted
/// every time, so a deep user stack declines before it overflows rather than
/// after.
///
/// <b>Suppression is the correctness half.</b> Inline publication is only safe
/// where the publisher holds no lock the continuation could re-enter. G#'s
/// blocking channel forms are what `lock { ch <- v }` compiles to, and
/// Monitor is reentrant: an inline receiver would run INSIDE the sender's
/// monitor and observe mutual exclusion it does not have. Those paths, and
/// cancellation callbacks, publish under (cref:Suppress).
internal shared class InlineBudget {
    /// The suppression scope; see (cref:Suppress).
    internal struct Scope : IDisposable {
        /// Initializes a new instance of the (cref:Scope) struct.
        init() {
            InlineBudget.counters.Value.suppressions++
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Dispose() {
            InlineBudget.counters.Value.suppressions--
        }
    }

    /// The default nesting limit. Sixteen is deep enough that a hand-off chain
    /// almost never pays the hop and shallow enough to be irrelevant against
    /// any real stack; the environment variable exists to measure the ends.
    private const DefaultLimit int32 = 16

    /// The per-thread counters.
    /// @remarks Held in a (cref:ThreadLocal{T}) rather than `@ThreadStatic` fields: the
    /// bootstrap compiler pinned in `global.json` drops `@ThreadStatic` on a
    /// `shared` field (issue #4903), which made the budget one process-wide
    /// counter. Revert to `@ThreadStatic` fields once the pinned SDK carries
    /// the emitter fix.
    private class Counters {
        internal var depth int32
        internal var suppressions int32
    }

    private let counters ThreadLocal[Counters] = ThreadLocal[Counters](() -> Counters())

    /// Gets the nesting limit; `GS_INLINE_DEPTH=0` restores the always-queue behaviour.
    private let _limit int32 = if int32.TryParse(
        Environment.GetEnvironmentVariable("GS_INLINE_DEPTH"),
        out var configured
    ) &&
        configured >= 0 {
        configured
    } else {
        DefaultLimit
    }

    internal prop Limit int32 {
        get {
            return _limit
        }
    }

    /// Takes an inline slot when one is available.
    /// @returns True when the caller may publish inline, and must then call (cref:Exit).
    internal func TryEnter() bool {
        let c = counters.Value
        if c.suppressions > 0 || c.depth >= Limit || !RuntimeHelpers.TryEnsureSufficientExecutionStack() {
            return false
        }
        c.depth++
        return true
    }

    /// Releases a slot taken by (cref:TryEnter).
    internal func Exit() {
        counters.Value.depth--
    }

    /// Forbids inline publication for the duration of the returned scope. Used
    /// where the publisher holds a lock, or is running inside a cancellation
    /// callback, and must not run a continuation on its own stack.
    /// @returns A scope that restores the previous state.
    internal func Suppress() Scope -> Scope()
}
