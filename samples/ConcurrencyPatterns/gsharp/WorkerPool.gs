package Patterns

import System
import System.Collections.Generic

func poolProduce(count int32, jobs out chan[int32]) {
    try {
        for value in 0 ... count {
            jobs <- value
        }
    } finally {
        jobs.Close()
    }
}

func poolWorker(jobs in chan[int32], results out chan[int32]) {
    for job in jobs {
        results <- job * 2
    }
}

func poolWorkers(jobs in chan[int32], results out chan[int32]) {
    try {
        scope {
            for worker in 0 ... 4 {
                go poolWorker(jobs, results)
            }
        }
    } finally {
        results.Close()
    }
}

func runPool(count int32) int32 {
    let jobs = chan[int32](4)
    let results = chan[int32](4)
    let seen = HashSet[int32]()
    var sum = 0
    scope {
        go poolProduce(count, jobs)
        go poolWorkers(jobs, results)
        for value in results {
            verify(seen.Add(value), "duplicate result")
            sum += value
        }
    }
    verify(seen.Count == count, "lost work")
    return sum
}

func workerPoolExample() {
    verify(runPool(0) == 0, "empty pool")
    verify(runPool(40) == 1560, "pool result")
    Console.WriteLine("worker-pool count=40 sum=1560 empty=0")
}
