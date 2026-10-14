// <copyright file="ScopeFrame.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Collections.Generic
import System.Runtime.ExceptionServices
import System.Threading
import System.Threading.Tasks
import SystemObject = System.Object

/// The runtime half of a `scope { … }` block (ADR-0174 D6): the sink its
/// goroutines report to, the owner of the block's (cref:Context), and
/// the join at exit. The pending count starts at one for the body itself;
/// every (cref:Register) adds one, every (cref:Complete) or
/// (cref:Fail) removes one, and (cref:ExitAsync) retires the
/// body's own count and waits for zero. The first failure cancels the frame's
/// context <em>inside</em> (cref:Fail) — siblings parked on a channel
/// unwind promptly, before the join, not after.
/// @remarks Exit precedence, from the ADR's table: a failing body with healthy
/// children rethrows the body's exception unwrapped; failing children raise a
/// (cref:ScopeException) in completion order; when both fail the body's
/// exception is at index 0; cancellation arriving from the <em>outer</em>
/// context alone rethrows the (cref:OperationCanceledException); and
/// cancellation the frame inflicted on itself (a child failed) reports the
/// causing failure and discards the siblings' cancellations.
///
/// The frame is a (cref:TaskCompletionSource) and an interlocked
/// counter — one allocation per scope. Pooling it behind an
/// `IValueTaskSource` is a Phase 5 refinement, gated on the concurrency
/// benchmark showing the allocation matters (ADR-0174 errata).
///
/// A join that outlives (cref:GsharpRuntime.ScopeStallTimeout)
/// raises (cref:GsharpRuntime.ScopeStalled) and keeps waiting: a scope
/// that promised to join keeps its promise, and the hook exists so a host can
/// see a goroutine that never completes.
class ScopeFrame : IGoroutineSink {
    private let completion TaskCompletionSource = TaskCompletionSource(
        TaskCreationOptions.RunContinuationsAsynchronously
    )
    private let ambient Context
    private let gate object = SystemObject()
    private var failures List[Exception]?
    private var pending int32 = 1

    private init(ambient Context) {
        this.ambient = ambient
        Context = ambient.WithCancel()
    }

    /// Gets the block's own context: cancelled by the first child failure or by the ambient context.
    prop Context Context {
        get;
    }

    /// Gets the number of registrations not yet completed, including the body's own until exit. A
    /// diagnostic snapshot.
    prop Pending int32 -> Volatile.Read(&pending)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Register() -> Interlocked.Increment(&pending)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Complete() {
        let remaining = Interlocked.Decrement(&pending)
        if remaining == 0 {
            completion.TrySetResult()
        } else if remaining < 0 {
            throw InvalidOperationException(
                "A scope frame completed more goroutines than were registered (ADR-0174 D5: Register must precede queueing)."
            )
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Fail(exception Exception) {
        RecordFailure(exception)
        Complete()
    }

    /// Retires the body's registration, joins every goroutine, releases the context, and throws per the
    /// exit precedence table.
    /// @param bodyException The exception the block body threw, or `null`.
    /// @returns A task that completes when every goroutine has completed.
    async func ExitAsync(bodyException Exception? = nil) ValueTask {
        Complete()
        await JoinAsync().ConfigureAwait(false)
        Context.Dispose()
        let exception Exception? = BuildExitException(bodyException)
        if exception != nil {
            ExceptionDispatchInfo.Throw(exception)
        }
    }

    /// Folds a child's failure into this scope without touching the pending
    /// count. An `async let` cell retires its own registration when the
    /// child completes, because the failure belongs to whoever reads the
    /// binding; when nobody does, the cell hands it back here at scope exit
    /// (ADR-0174 D15).
    /// @param exception The child's exception, unwrapped.
    func RecordChildFailure(exception Exception) -> RecordFailure(exception)

    /// The blocking form of (cref:ExitAsync), for the synthesized root that may block (ADR-0174 D4).
    /// @param bodyException The exception the block body threw, or `null`.
    func Exit(bodyException Exception? = nil) -> ExitAsync(bodyException).AsTask().GetAwaiter().GetResult()

    // Waits for every registration, reporting a stall through the runtime hook
    // if the join outlives GsharpRuntime.ScopeStallTimeout (ADR-0174 D6: the
    // documented partial mitigation for a goroutine that never completes). The
    // join is never abandoned — a scope that promised to join keeps its promise.
    private async func JoinAsync() ValueTask {
        let stallTimeout = GsharpRuntime.ScopeStallTimeout
        if stallTimeout == Timeout.InfiniteTimeSpan || completion.Task.IsCompleted {
            await completion.Task.ConfigureAwait(false)
            return
        }
        var waited = TimeSpan.Zero
        while true {
            let stall = Task.Delay(stallTimeout)
            let finished = await Task.WhenAny(completion.Task, stall).ConfigureAwait(false)
            if object.ReferenceEquals(finished, completion.Task) {
                await completion.Task.ConfigureAwait(false)
                return
            }
            waited += stallTimeout
            GsharpRuntime.RaiseScopeStalled(waited, Pending)
        }
    }

    private func RecordFailure(exception Exception) {
        lock gate {
            (
                (
                    if failures == nil {
                        (failures = List[Exception]())
                    } else {
                        failures
                    }
                )!!
            ).Add(exception)
        }
        // Prompt sibling cancellation: inside the failure path, before the join.
        Context.TryCancel()
    }

    private func BuildExitException(bodyException Exception?) Exception? {
        var children List[Exception]?
        lock gate {
            children = failures
            failures = nil
        }
        let bodyCancelledOnly = bodyException is OperationCanceledException
        if children == nil || children.Count == 0 {
            return bodyException
        }
        let real = children.FindAll((e Exception) -> !(e is OperationCanceledException))
        if bodyException != nil && !bodyCancelledOnly {
            let all = List[Exception](1 + real.Count){bodyException}
            all.AddRange(
                if real.Count > 0 {
                    real
                } else {
                    children
                }
            )
            return ScopeException(all)
        }
        if real.Count > 0 {
            // Self-inflicted cancellation: the causing failure leads, and the
            // siblings' (and the body's) OperationCanceledExceptions are noise.
            return ScopeException(real)
        }
        // Only cancellations. From the outer context they are not a failure;
        // a child that cancelled itself with nothing else failing is reported.
        return if ambient.IsCancelled {
            (bodyException ?? children[0])
        } else {
            cast[Exception](ScopeException(children))
        }
    }

    shared {
        /// Enters a scope under [`ambient`](paramref).
        /// @param ambient The enclosing context; `null` means (cref:Context.None).
        /// @returns The frame; call (cref:ExitAsync) (or (cref:Exit) at a root) exactly once.
        func Enter(ambient Context?) ScopeFrame -> ScopeFrame(ambient ?? Context.None)
    }
}
