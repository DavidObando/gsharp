// file: Pipeline.gs
//
// ADR-0174 pattern 3: a pipeline. Each stage owns its output channel, writes
// to it, and closes it when its input is drained; the next stage reads until
// that close. Ownership is in the signatures — a stage takes `in chan[T]` for
// what it reads and `out chan[T]` for what it writes, so no stage can close a
// channel it does not own.
//
// The stages run as goroutines inside a `scope`, so the block does not finish
// until every one of them has. Nothing here is `async`: suspension is inferred,
// and a channel operation parks the state machine rather than a thread.

package GSharp.Samples.Pipeline

import System

func generate(out1 out chan [int32], count int32) {
    for i in 1 ... count + 1 {
        out1 <- i
    }
    out1.Close()
}

func square(src in chan [int32], dst out chan [int32]) {
    for v in src {
        dst <- v * v
    }
    dst.Close()
}

scope {
    let numbers = chan [int32](4)
    let squares = chan [int32](4)

    go generate(numbers, 5)
    go square(numbers, squares)

    var total = 0
    for v in squares {
        Console.WriteLine("squared: $v")
        total = total + v
    }

    Console.WriteLine("total: $total")
}
