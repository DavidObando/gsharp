// <copyright file="GoroutineWorkItem.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks

/// The base class of every synthesized goroutine (ADR-0174 D5). `go f(args)`
/// evaluates `f` and its arguments on the spawning goroutine, constructs
/// a subclass instance holding them, and calls (cref:Start), which
/// registers with the (cref:Sink) <em>before</em> queueing the item on
/// the thread pool — no (cref:Task), no delegate. (cref:Run) is the
/// body; its pooled (cref:ValueTask) is consumed exactly once here, and
/// every outcome — synchronous throw, synchronous completion, asynchronous
/// fault — is routed to the sink. No exception ever escapes
/// (cref:IThreadPoolWorkItem.Execute).
abstract class GoroutineWorkItem : IThreadPoolWorkItem {
    private var awaiter ValueTaskAwaiter
    private var observe(() -> void)?

    /// Initializes a new instance of the (cref:GoroutineWorkItem) class.
    /// @param sink The completion sink — the enclosing scope's frame, or (cref:GoroutineRuntime.FreeSink).
    protected init(sink IGoroutineSink) {
        Sink = sink ?? throw ArgumentNullException("sink")
    }

    /// Gets the sink this goroutine reports to.
    prop Sink IGoroutineSink {
        get;
    }

    /// Gets the ambient cancellation context the body runs under.
    protected prop Context Context -> Sink.Context

    /// Registers with the sink, then queues the goroutine. The order is normative: the reverse races a fast
    /// child to completion before the scope knows it exists.
    func Start() {
        Sink.Register()
        GoroutineRuntime.OnStarted()
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: true)
    }

    /// Runs the body and routes its outcome to the sink. Never throws. The thread pool calls this; a host
    /// that schedules goroutines itself may too.
    func Execute() {
        var body ValueTask
        try {
            body = Run()
        } catch (exception Exception) {
            Finish(exception)
            return
        }
        awaiter = body.GetAwaiter()
        if awaiter.IsCompleted {
            Observe()
            return
        }
        awaiter.UnsafeOnCompleted(
            (
                if observe == nil {
                    (observe = Observe)
                } else {
                    observe
                }
            )!!
        )
    }

    /// The goroutine body.
    /// @returns The body's completion; consumed exactly once by this class.
    protected open func Run() ValueTask;

    private func Observe() {
        var failure Exception? = nil
        try {
            awaiter.GetResult()
        } catch (exception Exception) {
            failure = exception
        }
        awaiter = default(ValueTaskAwaiter)
        Finish(failure)
    }

    private func Finish(failure Exception?) {
        GoroutineRuntime.OnFinished()
        try {
            if failure == nil {
                Sink.Complete()
            } else {
                Sink.Fail(failure)
            }
        } catch (sinkFailure Exception) {
            // A sink that throws is a runtime defect, not a user failure; it
            // still must not escape Execute. Surface it the way a free
            // goroutine's failure surfaces.
            GoroutineRuntime.FreeSink.Fail(sinkFailure)
        }
    }
}
