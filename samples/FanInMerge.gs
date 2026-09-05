// file: FanInMerge.gs
//
// ADR-0174 pattern 4: fan-in. Two producers each own a channel; `merge` forwards
// both into one output channel and closes it once every input has closed. The
// merge is hand-rolled here — a `done` channel counts finished forwarders — and
// the consumer simply drains the merged channel with `for v in merged`. Each
// forwarder takes the handles it needs and nothing more: `in chan[T]` to read,
// `out chan[T]` to write.

package GSharp.Samples.FanInMerge

import System

func produce(ch out chan [int32], start int32, count int32) {
    for i in start ... start + count {
        ch <- i
    }
    ch.Close()
}

func forward(src in chan [int32], dst out chan [int32], done out chan [bool]) {
    for v in src {
        dst <- v
    }
    done <- true
}

func closeWhenDone(dst out chan [int32], done in chan [bool], forwarders int32) {
    for i in 0 ... forwarders {
        let (_, ok) = <-done
        if !ok {
            break
        }
    }
    dst.Close()
}

func merge(a in chan [int32], b in chan [int32]) in chan [int32] {
    let merged = chan [int32](8)
    let done = chan [bool](2)
    go forward(a, merged, done)
    go forward(b, merged, done)
    go closeWhenDone(merged, done, 2)
    return merged
}

let evens = chan [int32](4)
let odds = chan [int32](4)
go produce(evens, 0, 10)
go produce(odds, 100, 10)

var count = 0
var total = 0
for v in merge(evens, odds) {
    count = count + 1
    total = total + v
}

Console.WriteLine("merged: {0}", count)
Console.WriteLine("total: {0}", total)
