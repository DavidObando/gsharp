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
import System.Threading

// Issue #3902 (H2): three of the eight scenario bodies never reached Tier1.
// A scenario's `MoveNext` is entered ONCE and then loops, so call counting —
// which needs 30 invocations — could never promote it, and only on-stack
// replacement could. OSR does not fire for every G#-emitted body, and why is
// still undetermined.
//
// So the harness stops depending on OSR. `warmupRounds` exceeds the runtime's
// call-count threshold, at a cheap `warmupOps`, which promotes every body by
// the ordinary path before the measured round runs. This sidesteps H2 rather
// than solving it; H2 remains open, and matters wherever a hot loop inside a
// suspending function does not park.
// 120 rounds, not 40: a body that never parks is entered ONCE per call, and
// promotion is two-stage — roughly 30 calls to earn an instrumented rejit, then
// 30 more on that version to earn Tier1. Bodies that park reach both far sooner
// because every resume is another entry. 120 clears it for all eight.
let warmupRounds = 120
let warmupOps = 4000

// Issue #3902: counts are set so every scenario MEASURES for roughly a quarter
// of a second. They used to run 1-5 ms, where timer granularity and the CPU's
// own frequency ramp are a large fraction of the result — `chunk1k` measured
// 1.3 ms. The Go side carries the matching counts; a row whose two sides run
// for wildly different durations is not a comparison.
let ops = 2000000
let closedOps = 25000000
let spawnOps = 750000
let pingPongOps = 2000000
let roundTripOps = 1000000
let parkOps = 900000
let chunk64Ops = 32000000
let chunk1kOps = 75000000

func report(name string, elapsed TimeSpan, count int32) {
    let perOp = elapsed.TotalNanoseconds / float64(count)

    // Elapsed milliseconds travel with the rate so a scenario that is too short
    // to measure is visible as such rather than merely noisy. The Go side has
    // always printed it; the runner reads the `ns_per_op` token either way.
    Console.WriteLine(name + " ns_per_op " + perOp.ToString("F2") + " ms " + elapsed.TotalMilliseconds.ToString("F1"))
}

// A bounded channel driven producer-to-consumer: the shape a pipeline stage
// has, and the row the ADR's throughput claim rests on.
func buf64(count int32) TimeSpan {
    let ch = chan[int32](64)
    let sw = Stopwatch.StartNew()
    scope {
        go produce(ch, count)
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
// measures the hand-off itself rather than the buffer. ONE hand-off per counted
// operation, which is why it has no Go counterpart — Go's `pingpong` counts a
// round trip. `pingpong` below is the row that pairs with it (issue #3902 S1a).
func rendezvous(count int32) TimeSpan {
    let ch = chan[int32](0)
    let sw = Stopwatch.StartNew()
    scope {
        go produce(ch, count)
        for v in ch {
            let ignored = v
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// Go's `pingpong`, shape for shape: a round trip over two rendezvous channels,
// counted per ROUND TRIP and therefore two hand-offs per operation. The rows
// this replaces compared one hand-off against two and flattered G# by 2x.
func pingpong(count int32) TimeSpan {
    let a = chan[int32](0)
    let b = chan[int32](0)
    let sw = Stopwatch.StartNew()
    scope {
        go echo(a, b, count)
        for i in 0 ... count {
            a <- i
            let got = <-b
            let ignored = got
        }
    }

    sw.Stop()
    return sw.Elapsed
}

func echo(a in chan[int32], b out chan[int32], count int32) {
    for i in 0 ... count {
        let v = <-a
        b <- v
    }
}

// The 382x defect ADR-0174 D2 removes: a receive from a closed, drained
// channel used to raise an exception per call.
func closedRecv(count int32) TimeSpan {
    let ch = chan[int32](1)
    ch.Close()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let (value, ok) = <-ch
        let ignored = value
    }

    sw.Stop()
    return sw.Elapsed
}

// Spawn cost: `go` is a thread-pool work item, not a Task. Go's counterpart
// times the spawn and a WaitGroup join, so this does the same — it used to add
// a send and a receive per goroutine that Go never paid for (issue #3902 S1c).
// `scope` exit IS the join.
func spawn(count int32) TimeSpan {
    let sw = Stopwatch.StartNew()
    scope {
        for i in 0 ... count {
            go noop()
        }
    }

    sw.Stop()
    return sw.Elapsed
}

func noop() { }

// A select whose arms are ALREADY READY: the fast path, no registration and no
// park. Both arms are refilled each round so the uniform-random choice always
// has two candidates. Four channel operations per counted iteration (two sends,
// the select, one drain), so it has NO Go counterpart — `select-stream` below
// is the row that pairs with Go. Keeping this one G#-only is what preserves a
// genuine ready-path measurement for gate G5 (issue #3902 S1b).
func selectReady(count int32) TimeSpan {
    let a = chan[int32](1)
    let b = chan[int32](1)
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        a <- 1
        b <- 2
        select {
            case let v = <- a {
                let drained = <-b
            }
            case let w = <- b {
                let drained = <-a
            }
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// Go's `selectCost`, shape for shape: a producer fills one buffered arm and the
// timed loop performs exactly ONE select receive per counted operation. The
// consumer outruns the producer, so this measures a MIX of ready and parked
// selects — which is what Go's row measures too, and why it is a separate row
// from `select-ready` rather than a replacement for it.
func selectStream(count int32) TimeSpan {
    let a = chan[int32](1024)
    let b = chan[int32](1024)
    let sw = Stopwatch.StartNew()
    scope {
        go feed(a, count)
        var got = 0
        while got < count {
            select {
                case let v = <- a {
                    got = got + 1
                }
                case let w = <- b {
                    got = got + 1
                }
            }
        }
    }

    sw.Stop()
    return sw.Elapsed
}

// Like `produce` but leaves the channel open: a closed arm would make the
// select return immediately with the zero value and miscount the loop.
func feed(ch out chan[int32], count int32) {
    for i in 0 ... count {
        ch <- i
    }
}

// A select with no ready arm: registration on every arm, a park, and a
// hand-off. This is the path wave 1 could not measure at all.
func selectPark(count int32) TimeSpan {
    let a = chan[int32](0)
    let b = chan[int32](0)
    let sw = Stopwatch.StartNew()
    scope {
        go produce(a, count)
        var taken = 0
        while taken < count {
            select {
                case let v = <- a {
                    taken = taken + 1
                }
                case let w = <- b {
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

// Go's chunk rows send whole `[]int` slices over a `chan []int`; the `chunks()`
// rows above are a G# construct that copies elements into a fresh array per
// chunk. Comparing the two measured different transports (issue #3902 S1d), so
// this is the row that pairs with Go, and `chunk64`/`chunk1k` are now G#-only.
func chunkedArrays(size int32, count int32) TimeSpan {
    let ch = chan[[]int32](64)
    let sw = Stopwatch.StartNew()
    scope {
        go produceArrays(ch, count, size)
        var sum = 0
        for batch in ch {
            var i = 0
            while i < batch.Length {
                sum = sum + batch[i]
                i = i + 1
            }
        }
    }

    sw.Stop()
    return sw.Elapsed
}

func produceArrays(ch out chan[[]int32], count int32, size int32) {
    var sent = 0
    while sent < count {
        var chunk = [size]int32{}
        var i = 0
        while i < size && sent + i < count {
            chunk[i] = sent + i
            i = i + 1
        }

        ch <- chunk
        sent = sent + i
    }

    ch.Close()
}

func run(name string) {
    if name == "buf64" {
        report("buf64", buf64(ops), ops)
    } else if name == "rendezvous" {
        report("rendezvous", rendezvous(pingPongOps), pingPongOps)
    } else if name == "closed-recv" {
        report("closed-recv", closedRecv(closedOps), closedOps)
    } else if name == "spawn" {
        report("spawn", spawn(spawnOps), spawnOps)
    } else if name == "select-ready" {
        report("select-ready", selectReady(ops), ops)
    } else if name == "select-stream" {
        report("select-stream", selectStream(ops), ops)
    } else if name == "select-park" {
        report("select-park", selectPark(parkOps), parkOps)
    } else if name == "chunk64" {
        report("chunk64", chunked(64, chunk64Ops), chunk64Ops)
    } else if name == "chunk1k" {
        report("chunk1k", chunked(1024, chunk1kOps), chunk1kOps)
    } else if name == "pingpong" {
        report("pingpong", pingpong(roundTripOps), roundTripOps)
    } else if name == "chunk64-arrays" {
        report("chunk64-arrays", chunkedArrays(64, chunk64Ops), chunk64Ops)
    } else if name == "chunk1k-arrays" {
        report("chunk1k-arrays", chunkedArrays(1024, chunk1kOps), chunk1kOps)
    }
}

// Same work at a cheap op count, no output. Called warmupRounds times so the
// runtime's call counter promotes every scenario body before it is measured.
func runWarmup(name string) {
    if name == "buf64" {
        let ignored = buf64(warmupOps)
    } else if name == "rendezvous" {
        let ignored = rendezvous(warmupOps)
    } else if name == "closed-recv" {
        let ignored = closedRecv(warmupOps)
    } else if name == "spawn" {
        let ignored = spawn(warmupOps)
    } else if name == "select-ready" {
        let ignored = selectReady(warmupOps)
    } else if name == "select-stream" {
        let ignored = selectStream(warmupOps)
    } else if name == "select-park" {
        let ignored = selectPark(warmupOps)
    } else if name == "chunk64" {
        let ignored = chunked(64, warmupOps)
    } else if name == "chunk1k" {
        let ignored = chunked(1024, warmupOps)
    } else if name == "pingpong" {
        let ignored = pingpong(warmupOps)
    } else if name == "chunk64-arrays" {
        let ignored = chunkedArrays(64, warmupOps)
    } else if name == "chunk1k-arrays" {
        let ignored = chunkedArrays(1024, warmupOps)
    }
}

let all = []string{
    "buf64",
    "rendezvous",
    "pingpong",
    "closed-recv",
    "spawn",
    "select-ready",
    "select-stream",
    "select-park",
    "chunk64",
    "chunk1k",
    "chunk64-arrays",
    "chunk1k-arrays"
}
let requested = Environment.GetEnvironmentVariable("GSHARP_BENCH_SCENARIO")

Console.WriteLine("runtime " + Environment.Version.ToString() + " cores " + Environment.ProcessorCount.ToString())

for round in 0 ... warmupRounds {
    for name in all {
        if requested == nil || requested == "" || requested == name {
            runWarmup(name)
        }
    }
}

// Tier1 compilation is queued when the call counter trips and installed by a
// background thread. Give it room to land before measuring, or the measured
// round races the promotion it just paid for.
Thread.Sleep(250)
GC.Collect()
GC.WaitForPendingFinalizers()

for name in all {
    if requested == nil || requested == "" || requested == name {
        run(name)
    }
}
