package Patterns

import Gsharp.Concurrency
import System
import System.Threading

class AllState {
    public var Exited int32
}

func allValue(output out chan[int32], value int32) {
    output <- value
}

func allHealthy(output out chan[int32], ready out chan[bool]) {
    output <- 7
    ready <- true
}

func allBlocked(quiet in chan[int32], started out chan[bool], state AllState, context Context) {
    try {
        started <- true
        let unexpected = <-quiet
        verify(false, "blocked child received unexpected data")
    } catch (e OperationCanceledException) {
        if !context.IsCancelled {
            rethrow
        }
    } finally {
        Interlocked.Increment(ref state.Exited)
    }
}

func allFail(ready in chan[bool], started in chan[bool]) {
    let (_, readyOk) = <-ready
    let (_, startedOk) = <-started
    verify(readyOk && startedOk, "failure barrier")
    throw InvalidOperationException("expected failure")
}

func allUnrequestedCancellation() {
    throw OperationCanceledException("not requested")
}

func allExample() {
    scope { }
    let successful = chan[int32](3)
    scope {
        for value in 1 ... 4 {
            go allValue(successful, value)
        }
    }
    verify(<-successful + <-successful + <-successful == 6, "successful children")
    let output = chan[int32](1)
    let ready = chan[bool](1)
    let started = chan[bool](1)
    let quiet = chan[int32](1)
    let state = AllState()
    var failures = 0
    try {
        scope {
            go allHealthy(output, ready)
            go allBlocked(quiet, started, state, ctx)
            go allFail(ready, started)
        }
    } catch (e ScopeException) {
        failures = e.InnerExceptions.Count
        verify(e.InnerExceptions[0].Message == "expected failure", "failure cause")
    }
    verify(failures == 1 && state.Exited == 1 && <-output == 7, "failure propagation and join")
    var unrelated = 0
    try {
        scope {
            go allUnrequestedCancellation()
        }
    } catch (e ScopeException) {
        unrelated = e.InnerExceptions.Count
    }
    verify(unrelated == 1, "unrequested cancellation must remain a failure")
    Console.WriteLine("all success=6 failures=1 blocked-child-joined=1 empty=0")
}
