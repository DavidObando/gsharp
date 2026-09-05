// file: ScopeAll.gs
//
// ADR-0174 pattern 7: wait for all, and collect what failed. A `scope` joins
// every goroutine started inside it. When one fails, its siblings are
// cancelled promptly — a sibling parked on a channel unwinds instead of
// waiting forever — and the block raises a `ScopeException` naming the cause.
//
// The healthy children still ran; the failure is not lost and the block does
// not finish early.

package GSharp.Samples.ScopeAll

import Gsharp.Concurrency
import System

func succeed(results out chan[int32], value int32, ready out chan[bool]) {
    results <- value
    ready <- true
}

// Waits for both healthy workers before failing, so the sample's output does
// not depend on how the pool happens to schedule them.
func failAfter(ready in chan[bool], workers int32) {
    for i in 0 ... workers {
        let (_, ok) = <-ready
    }

    throw Exception("worker failed")
}

let results = chan[int32](4)
let ready = chan[bool](2)

try {
    scope {
        go succeed(results, 1, ready)
        go succeed(results, 2, ready)
        go failAfter(ready, 2)
    }
} catch (e ScopeException) {
    Console.WriteLine("scope failed: " + e.InnerExceptions.Count.ToString())
    for inner in e.InnerExceptions {
        Console.WriteLine("  cause: " + inner.Message)
    }
}

results.Close()
var total = 0
for v in results {
    total = total + v
}

Console.WriteLine("delivered: $total")
