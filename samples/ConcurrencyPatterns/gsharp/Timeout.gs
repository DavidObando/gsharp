package Patterns

import Gsharp.Concurrency
import System
import System.Threading
import System.Threading.Tasks

class TimeoutState {
    public var Exited int32
}

func timeoutWork(input in chan[int32], started out chan[bool], state TimeoutState, context Context) {
    try {
        started <- true
        let unexpected = <-input
        verify(false, "unexpected timeout work result")
    } catch (e OperationCanceledException) {
        if !context.IsCancelled {
            rethrow
        }
    } finally {
        Interlocked.Increment(ref state.Exited)
    }
}

func timeoutExample() {
    let ready = chan[int32](1)
    ready <- 42
    var value = 0
    scope {
        using let readyDeadline = after(TimeSpan.FromMinutes(1))
        select {
            case let result = <- ready {
                value = result
            }
            case <- readyDeadline {
                verify(false, "ready value timed out")
            }
        }
    }
    verify(value == 42, "ready result")
    let quiet = chan[int32](1)
    let started = chan[bool](1)
    let state = TimeoutState()
    var timedOut = false
    scope {
        go timeoutWork(quiet, started, state, ctx)
        let (_, ok) = <-started
        verify(ok, "timeout start barrier")
        using let deadline = after(TimeSpan.FromMilliseconds(5))
        select {
            case let unexpected = <- ready {
                verify(false, "unexpected result")
            }
            case <- deadline {
                timedOut = true
                ctx.TryCancel()
            }
        }
    }
    var cancelled = false
    scope {
        ctx.TryCancel()
        select {
            case let unexpected = <- quiet {
                verify(false, "unexpected cancellation result")
            }
            case cancelled {
                cancelled = true
            }
        }
    }
    verify(timedOut && cancelled && state.Exited == 1, "timeout cleanup")
    using let contextDeadline = Context.None.WithTimeout(TimeSpan.FromMilliseconds(5))
    var contextTimedOut = false
    try {
        await Task.Delay(Timeout.InfiniteTimeSpan, contextDeadline.Token)
    } catch (e OperationCanceledException) {
        contextTimedOut = contextDeadline.IsCancelled
    }
    verify(contextTimedOut, "context deadline for a .NET task")
    Console.WriteLine("timeout ready=42 deadline=1 cancellation=1 joined=1")
}
