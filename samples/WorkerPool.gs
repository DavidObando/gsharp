// file: WorkerPool.gs
//
// ADR-0174 pattern 1: a worker pool. Jobs flow through a buffered channel to
// four workers that each take an `in chan[int32]` (receive-only) and an
// `out chan[int32]` (send-only); `for job in jobs` drains until the producer
// closes the channel, and the enclosing `scope` joins every worker before the
// results channel is closed and summed. No import is needed for any of it.

package GSharp.Samples.WorkerPool

import System

func worker(id int32, jobs in chan[int32], results out chan[int32]) {
    for job in jobs {
        results <- job * job
    }
}

let jobCount = 20
let jobs = chan[int32](jobCount)
let results = chan[int32](jobCount)

for job in 1 ... jobCount + 1 {
    jobs <- job
}
jobs.Close()

scope {
    for id in 1 ... 5 {
        go worker(id, jobs, results)
    }
}
results.Close()

var sum = 0
var count = 0
for r in results {
    sum = sum + r
    count = count + 1
}

Console.WriteLine("results: {0}", count)
Console.WriteLine("sum of squares: {0}", sum)
let (leftover, ok) = <-results
Console.WriteLine("drained: {0} {1}", leftover, ok)
