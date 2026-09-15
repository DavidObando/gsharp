package Patterns

import System
import System.Threading

class AtomicState {
    public var Count int32
    public var FactoryRuns int32
}

func useLazy(value Lazy[int32], state AtomicState) {
    verify(value.Value == 42, "lazy result")
    Interlocked.Increment(ref state.Count)
}

func atomicLazyExample() {
    let state = AtomicState()
    let value = Lazy[int32](
        () -> {
            Interlocked.Increment(ref state.FactoryRuns)
            42
        },
        LazyThreadSafetyMode.ExecutionAndPublication
    )
    verify(state.FactoryRuns == 0, "eager initialization")
    scope {
        for id in 0 ... 40 {
            go useLazy(value, state)
        }
    }
    verify(state.Count == 40 && state.FactoryRuns == 1, "atomic count or initialization")
    verify(value.Value == 42 && state.FactoryRuns == 1, "repeated lazy read")
    Console.WriteLine("atomic-lazy count=40 factories=1 value=42")
}
