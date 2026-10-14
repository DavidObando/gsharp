// <copyright file="AsyncLetCell.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading
import System.Threading.Tasks

/// The runtime half of `async let name = expr` (ADR-0174 D15): the cell a
/// spawned child reports its value to, and the thing `await name` reads.
/// @remarks The cell is a child of the enclosing (cref:ScopeFrame) and
/// participates in its pending count, cancellation and failure aggregation
/// exactly as a `go` child does. It is never a user-visible value: the
/// binding names a result of type `R`, not a handle, which is what keeps
/// the pooled `ValueTask` builder usable — the compiler owns the
/// completion object, so it is consumed exactly once.
///
/// The class is deliberately <em>not</em> generic in the result: a
/// same-compilation result type has no reference-context CLR type, so a
/// generic cell would close over (cref:object) in metadata while the
/// call site believed it was closed over the user's type. The type parameter
/// lives on (cref:Run{TResult}(ValueTask{TResult})) and
/// (cref:AwaitAsync{TResult}) instead, where the compiler's symbolic
/// method-type-argument machinery already carries it — the same shape
/// `ChannelOps` uses for a channel element.
///
/// Failure surfaces at the `await`. A binding that is never read has
/// its child cancelled at scope exit and joined; a failure the reader never saw
/// is folded into the scope's (cref:ScopeException) rather than
/// dropped.
class AsyncLetCell : IGoroutineSink {
    private let frame ScopeFrame
    private let completion TaskCompletionSource[object?] = TaskCompletionSource[object?](
        TaskCreationOptions.RunContinuationsAsynchronously
    )
    private var read int32
    private var retired int32

    private init(frame ScopeFrame) {
        this.frame = frame
        // The child's own context: cancelling it at scope exit unwinds an
        // unread child without disturbing its siblings.
        Context = frame.Context.WithCancel()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Context Context {
        get;
    }

    /// Gets a value indicating whether the binding has been read at least once. A diagnostic snapshot.
    prop WasRead bool -> Volatile.Read(&read) != 0

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Register() -> frame.Register()

    /// Records a child that finished without depositing a value. The work item
    /// calls this after the body's `ValueTask` is consumed, by which time
    /// `Run` has normally already deposited the result; both paths retire
    /// the frame's registration exactly once.
    func Complete() {
        completion.TrySetResult(nil)
        Retire()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Fail(exception Exception) {
        // The failure belongs to whoever reads the binding. If nobody does,
        // CancelIfUnreadAsync hands it back to the scope at exit — so the
        // frame's count is retired here, but its failure list is not touched,
        // and siblings are not cancelled. Catching a failed `async let` must
        // not kill the ones running beside it.
        completion.TrySetException(exception)
        Retire()
    }

    /// Runs a child whose body yields its result directly.
    /// @typeparam TResult The child's result type.
    /// @param body The child's already-computed result.
    /// @returns A completed task.
    func Run[TResult](body TResult) ValueTask {
        Deposit(body)
        return default(ValueTask)
    }

    /// Runs a child whose body yields a (cref:ValueTask{TResult}) — a suspending call.
    /// @typeparam TResult The child's result type.
    /// @param body The child's completion.
    /// @returns The child's completion, with the result deposited.
    async func Run[TResult](body ValueTask[TResult]) ValueTask -> Deposit(await body.ConfigureAwait(false))

    /// Runs a child whose body yields a (cref:Task{TResult}) — an `async func` call.
    /// @typeparam TResult The child's result type.
    /// @param body The child's task.
    /// @returns The child's completion, with the result deposited.
    async func Run[TResult](body Task[TResult]) ValueTask -> Deposit(await body.ConfigureAwait(false))

    /// Reads the binding. The second and later reads return the completed value without suspending.
    /// @typeparam TResult The child's result type.
    /// @returns The child's result.
    async func AwaitAsync[TResult]() ValueTask[TResult] {
        Volatile.Write(&read, 1)
        let value object? = await completion.Task.ConfigureAwait(false)
        // TResult is unconstrained: its zero value is what a child that
        // deposited nothing is defined to yield, and it may be null.
        return if value == nil {
            ReceiveResult[TResult].ZeroValue()
        } else {
            TResult(value)
        }
    }

    /// The blocking form of (cref:CancelIfUnreadAsync), for the
    /// synthesized root that may block (ADR-0174 D4). The compiler emits this
    /// and the async lowering rewrites it, exactly as it does a scope's exit.
    func CancelIfUnread() -> CancelIfUnreadAsync().AsTask().GetAwaiter().GetResult()

    /// Scope exit: an unread binding's child is cancelled and joined, and a
    /// failure nobody saw is folded into the scope. Called once per cell, in
    /// the enclosing scope's cleanup, before the frame's own exit.
    /// @returns A task that completes when the child has.
    async func CancelIfUnreadAsync() ValueTask {
        if WasRead {
            Context.Dispose()
            return
        }
        Context.TryCancel()
        try {
            await completion.Task.ConfigureAwait(false)
        } catch (OperationCanceledException) {
            // The cancellation this method asked for is not a failure.

        } catch (exception Exception) {
            frame.RecordChildFailure(exception)
        } finally {
            Context.Dispose()
        }
    }

    private func Deposit(value object?) {
        completion.TrySetResult(value)
        Retire()
    }

    // The frame learns of this child exactly once, whichever path gets here
    // first: the body's own deposit, or the work item's completion call after
    // the body's ValueTask has been consumed.
    private func Retire() {
        if Interlocked.Exchange(&retired, 1) == 0 {
            frame.Complete()
        }
    }

    shared {
        /// Opens a cell owned by [`frame`](paramref).
        /// @param frame The enclosing scope's frame.
        /// @returns The cell; the compiler queues a work item whose sink is it.
        func Start(frame ScopeFrame) AsyncLetCell -> AsyncLetCell(frame ?? throw ArgumentNullException("frame"))
    }
}
