// file: PortScan.gs
//
// Phase 5 exit sample. Combines the entire Go-shaped concurrency surface that
// landed in Phase 5: `chan[T]` (5.4), send/receive (5.5), `go` (5.3), structured
// concurrency `scope { ... }` (5.7), and a `select { ... }` with a timeout arm
// (5.6). The synthetic "scanner" assigns even
// ports as open and odd ports as closed; the timeout demo prefers a pre-loaded
// timeout channel over a worker that never sends.
//
// Originally lived under samples/aspirational/ while Phase 5 emit was
// deferred (ADR-0022 §Consequences); it was promoted here once the emit
// backend covered the full concurrency surface, and the regular conformance
// harness now matches stdout against PortScan.golden.

package GSharp.Samples.PortScan

import System
import System.Threading

func scan(port int32, results chan[int32]) {
    Thread.Sleep(5)
    if port % 2 == 0 {
        results <- port
    } else {
        results <- 0
    }
}

let results = chan[int32](4)
scope {
    go scan(80, results)
    go scan(81, results)
    go scan(443, results)
    go scan(8080, results)
}

// After the scope exits, all four results are buffered on `results`. Drain
// them through a `select` with a single receive arm — exercises the source-
// order TryRead path of the select algorithm without any racing.
var opened = 0
var i = 0
for i < 4 {
    select {
    case let v = <-results {
        if v > 0 {
            opened = opened + 1
        }
    }
    }
    i = i + 1
}
Console.WriteLine("open ports: $opened")

// Timeout demo: a slow worker that never arrives, raced against a buffered
// "timeout" channel pre-loaded with a sentinel. The select picks the ready
// arm deterministically (source order, TryRead succeeds first).
let slow = chan[int32](1)
let timeoutCh = chan[int32](1)
timeoutCh <- 1
select {
case let v = <-slow {
    Console.WriteLine("got value: $v")
}
case <-timeoutCh {
    Console.WriteLine("timed out")
}
}
