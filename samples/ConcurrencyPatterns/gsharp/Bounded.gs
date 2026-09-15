package Patterns

import System
import System.Threading

class LimitState {
    public let Gate Object = Object()
    public var Active int32
    public var Peak int32
    public var Completed int32
    public var Failed int32
}

func limitedWork(id int32, permits SemaphoreSlim, state LimitState) {
    try {
        lock state.Gate {
            state.Active++
            state.Peak = Math.Max(state.Peak, state.Active)
        }
        try {
            if id == 7 {
                throw InvalidOperationException("expected work failure")
            }
            Thread.Yield()
        } catch (e InvalidOperationException) {
            lock state.Gate { state.Failed++ }
        } finally {
            lock state.Gate {
                state.Active--
                state.Completed++
            }
        }
    } finally {
        permits.Release()
    }
}

func boundedExample() {
    using let permits = SemaphoreSlim(3, 3)
    let state = LimitState()
    scope {
        for id in 0 ... 24 {
            await permits.WaitAsync()
            go limitedWork(id, permits, state)
        }
    }
    verify(state.Peak <= 3, "concurrency limit")
    verify(state.Completed == 24 && state.Failed == 1, "completion or failure accounting")
    verify(state.Active == 0 && permits.CurrentCount == 3, "permit leak")
    Console.WriteLine("bounded limit=3 completed=24 failures=1 permits=3")
}
