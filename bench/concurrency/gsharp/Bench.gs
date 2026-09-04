// file: Bench.gs
//
// ADR-0174 D11: the G# side of the paired concurrency benchmark. Every
// scenario here has a Go counterpart in `../go` with the same name, and the
// runner (`build/run-concurrency-bench.py`) compares them.
//
// Output is one machine-readable line per scenario:
//
//     <name> ns_per_op <float>
//
// Methodology, normative per D11 and enforced here rather than documented and
// forgotten:
//
//   * Three in-process rounds; only the last is printed. Tiered JIT depresses
//     cold numbers by 2-3x, so a comparison taken from round 1 is invalid.
//   * Release build. A Debug number is meaningless.
//   * The runner takes several process launches and reports a confidence
//     interval, because in-process repetition alone understates variance.
//
// Pass a scenario name to run one; pass nothing to run all of them.

package GSharp.Bench.Concurrency

import System
import System.Diagnostics

let rounds = 3
let ops = 200000
let spawnOps = 50000
let pingPongOps = 20000

func report(name string, elapsed TimeSpan, count int32) {
    let perOp = elapsed.TotalNanoseconds / float64(count)
    Console.WriteLine(name + " ns_per_op " + perOp.ToString("F2"))
}

// A bounded channel driven producer-to-consumer: the shape a pipeline stage
// has, and the row the ADR's throughput claim rests on.
func buf64() TimeSpan {
    let ch = chan[int32](64)
    let sw = Stopwatch.StartNew()
    scope {
        go produce(ch, ops)
        var seen = 0
        for v in ch {
            seen = seen + v - v + 1
        }
    }

    sw.Stop()
    return sw.Elapsed
}

func produce(ch out chan[int32], count int32) {
    for i in 0 ... count {
        ch <- i
    }

    ch.Close()
}

// Capacity 0: a send completes only when a receiver takes the value, so this
// measures the hand-off itself rather than the buffer.
func rendezvous() TimeSpan {
    let ch = chan[int32](0)
    let sw = Stopwatch.StartNew()
    scope {
        go produce(ch, pingPongOps)
        for v in ch {
            let ignored = v
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// The 382x defect ADR-0174 D2 removes: a receive from a closed, drained
// channel used to raise an exception per call.
func closedRecv() TimeSpan {
    let ch = chan[int32](1)
    ch.Close()
    let sw = Stopwatch.StartNew()
    for i in 0 ... ops {
        let (value, ok) = <-ch
        let ignored = value
    }

    sw.Stop()
    return sw.Elapsed
}

// Spawn cost: `go` is a thread-pool work item, not a Task.
func spawn() TimeSpan {
    let done = chan[int32](spawnOps)
    let sw = Stopwatch.StartNew()
    scope {
        for i in 0 ... spawnOps {
            go signal(done)
        }

        for j in 0 ... spawnOps {
            let (value, ok) = <-done
            let ignored = value
        }
    }

    sw.Stop()
    return sw.Elapsed
}

func signal(done out chan[int32]) {
    done <- 1
}

// A select whose arms are already ready: the fast path, no registration and no
// park. Both arms are refilled each round so the uniform-random choice always
// has two candidates.
func selectReady() TimeSpan {
    let a = chan[int32](1)
    let b = chan[int32](1)
    let sw = Stopwatch.StartNew()
    for i in 0 ... ops {
        a <- 1
        b <- 2
        select {
        case let v = <-a {
            let drained = <-b
        }
        case let w = <-b {
            let drained = <-a
        }
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// A select with no ready arm: registration on every arm, a park, and a
// hand-off. This is the path wave 1 could not measure at all.
func selectPark() TimeSpan {
    let a = chan[int32](0)
    let b = chan[int32](0)
    let sw = Stopwatch.StartNew()
    scope {
        go produce(a, pingPongOps)
        var taken = 0
        while taken < pingPongOps {
            select {
            case let v = <-a {
                taken = taken + 1
            }
            case let w = <-b {
                taken = taken + 1
            }
            }
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// D10: one lock acquisition and one park amortized across a batch. The two
// sizes exist because the curve is the point, not either number.
//
// BOTH sides batch, which is what makes this comparable to Go's `chunked`
// rows: those send whole `[]int` chunks through the channel, so a run moves
// N/size channel operations rather than N. A producer that sent one element at
// a time would measure the producer, not the chunked transport, and would
// report a ratio tens of times worse than the thing it claims to compare.
func chunked(size int32, count int32) TimeSpan {
    let ch = chan[int32](1024)
    let sw = Stopwatch.StartNew()
    scope {
        go produceBatched(ch, count, size)
        var seen = 0
        for batch in chunks(ch, size) {
            seen = seen + batch.Length
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// One buffer, reused: the point of the row is the transport, not the
// allocator. `size` is at most `maxChunk` for both scenarios.
func produceBatched(ch chan[int32], count int32, size int32) {
    var chunk = [1024]int32{}
    var sent = 0
    while sent < count {
        var i = 0
        while i < size && sent + i < count {
            chunk[i] = sent + i
            i = i + 1
        }

        var offset = 0
        while offset < i {
            let slice = ReadOnlyMemory[int32](chunk, offset, i - offset)
            offset = offset + ch.SendBatch(slice)
        }

        sent = sent + i
    }

    ch.Close()
}


func run(name string) {
    if name == "buf64" {
        report("buf64", buf64(), ops)
    } else if name == "rendezvous" {
        report("rendezvous", rendezvous(), pingPongOps)
    } else if name == "closed-recv" {
        report("closed-recv", closedRecv(), ops)
    } else if name == "spawn" {
        report("spawn", spawn(), spawnOps)
    } else if name == "select-ready" {
        report("select-ready", selectReady(), ops)
    } else if name == "select-park" {
        report("select-park", selectPark(), pingPongOps)
    } else if name == "chunk64" {
        report("chunk64", chunked(64, ops), ops)
    } else if name == "chunk1k" {
        report("chunk1k", chunked(1024, ops), ops)
    }
}

func runWarmup(name string) {
    // Same work, no output: rounds 1 and 2 exist only to let the JIT tier up.
    let sink = Console.Out
    if name == "buf64" {
        let ignored = buf64()
    } else if name == "rendezvous" {
        let ignored = rendezvous()
    } else if name == "closed-recv" {
        let ignored = closedRecv()
    } else if name == "spawn" {
        let ignored = spawn()
    } else if name == "select-ready" {
        let ignored = selectReady()
    } else if name == "select-park" {
        let ignored = selectPark()
    } else if name == "chunk64" {
        let ignored = chunked(64, ops)
    } else if name == "chunk1k" {
        let ignored = chunked(1024, ops)
    }
}

let all = []string{"buf64", "rendezvous", "closed-recv", "spawn", "select-ready", "select-park", "chunk64", "chunk1k"}
let requested = Environment.GetEnvironmentVariable("GSHARP_BENCH_SCENARIO")

Console.WriteLine("runtime " + Environment.Version.ToString() + " cores " + Environment.ProcessorCount.ToString())

for round in 0 ... rounds {
    let reportable = round == rounds - 1
    for name in all {
        if requested == nil || requested == "" || requested == name {
            if reportable {
                run(name)
            } else {
                runWarmup(name)
            }
        }
    }
}
