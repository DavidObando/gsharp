// <copyright file="GoroutineRuntime.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Threading
import System.Threading.Tasks

/// Process-wide goroutine bookkeeping (ADR-0174 D5): the sink for goroutines
/// started outside any `scope`, the hook a host uses to observe or
/// override their failures, and a live count for diagnostics.
/// @remarks A free goroutine is <em>fail-fast</em> by default — an unhandled exception
/// terminates the process, as an unrecovered Go panic does — because a
/// goroutine nobody joins has nowhere else to deliver a failure, and
/// swallowing it would be the wave-1 `Task.Run` behavior this ADR
/// retires. Subscribing to (cref:UnhandledGoroutineException) and
/// setting (cref:UnhandledGoroutineExceptionEventArgs.Handled) keeps the
/// process alive; the exception is then the host's to log or rethrow.
shared class GoroutineRuntime {
    private class DelegateGoroutine : GoroutineWorkItem {
        private let body() -> ValueTask

        init(sink IGoroutineSink, body() -> ValueTask) : base(sink) {
            this.body = body
        }

        protected override func Run() ValueTask -> body()
    }

    private class FreeGoroutineSink : IGoroutineSink {
        prop Context Context -> Context.None

        func Register() { }

        func Complete() { }

        func Fail(exception Exception) {
            if GoroutineRuntime.TryHandle(exception) {
                return
            }
            Environment.FailFast(
                "An unhandled exception escaped a free goroutine (one started by `go` outside any `scope`). " +
                    "ADR-0174 D5: a free goroutine is fail-fast, like an unrecovered Go panic; run it inside a `scope` to " +
                    "have the failure propagate, or handle GoroutineRuntime.UnhandledGoroutineException to observe it.",
                exception
            )
        }
    }

    private var live int64

    /// Raised on the faulting thread when a free goroutine fails, before the process is terminated.
    event UnhandledGoroutineException EventHandler[UnhandledGoroutineExceptionEventArgs]

    /// Gets the sink for goroutines started outside any `scope`.
    private let _freeSink IGoroutineSink = FreeGoroutineSink()

    prop FreeSink IGoroutineSink {
        get {
            return _freeSink
        }
    }

    /// Gets the number of goroutines started and not yet completed. A diagnostic snapshot, racy by nature.
    prop LiveGoroutines int64 -> Volatile.Read(&live)

    /// Starts a goroutine whose body is [`body`](paramref), reporting to
    /// [`sink`](paramref): registers before queueing, never lets an exception
    /// escape the pool thread, consumes the body's (cref:ValueTask) exactly
    /// once. This is the delegate-shaped entry the compiler emits until the
    /// synthesized work item derives from (cref:GoroutineWorkItem) directly
    /// (one delegate and one item per spawn; no (cref:Task)).
    /// @param body The goroutine body.
    /// @param sink The completion sink; `null` means (cref:FreeSink).
    func Start(body() -> ValueTask, sink IGoroutineSink?) {
        ArgumentNullException.ThrowIfNull(body, paramName: "body")
        DelegateGoroutine(sink ?? FreeSink, body).Start()
    }

    /// Erases a goroutine body's result: `go f(x)` where `f` yields a
    /// value discards it (ADR-0022), so the synthesized body returns a plain
    /// (cref:ValueTask). A completed result costs nothing; a pending one
    /// is observed through its task.
    /// @typeparam T The discarded result type.
    /// @param pending The body's pending result.
    /// @returns A task that completes when [`pending`](paramref) does, faulting the same way.
    func Discard[T](pending ValueTask[T]) ValueTask {
        if pending.IsCompletedSuccessfully {
            let _ = pending.Result
            return ValueTask.CompletedTask
        }
        return ValueTask(pending.AsTask())
    }

    /// Wraps a goroutine body that yields a (cref:Task) (an `async func` operand).
    /// @param pending The body's task.
    /// @returns A (cref:ValueTask) over it.
    func Wrap(pending Task) ValueTask -> ValueTask(pending)

    internal func OnStarted() -> Interlocked.Increment(&live)

    internal func OnFinished() -> Interlocked.Decrement(&live)

    /// Offers [`exception`](paramref) to the host hook.
    /// @param exception The free goroutine's failure.
    /// @returns `true` when a subscriber marked it handled.
    internal func TryHandle(exception Exception) bool {
        let handlers EventHandler[UnhandledGoroutineExceptionEventArgs]? = UnhandledGoroutineException
        if handlers == nil {
            return false
        }
        let args = UnhandledGoroutineExceptionEventArgs(exception)
        handlers(nil, args)
        return args.Handled
    }
}
