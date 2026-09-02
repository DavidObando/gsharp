// file: ChannelOwnership.gs
//
// ADR-0174 pattern 9: channel ownership. The producer constructs the channel,
// is the only party that sends and closes, and hands out a receive-only
// `in chan[int32]` — a handle nobody can close or send on (`GS0549`). The
// consumer loops with `while let` until close, then uses the two-value receive
// to observe that the channel is closed rather than merely holding a zero.

package GSharp.Samples.ChannelOwnership

import System

func fill(ch out chan[int32], count int32) {
    for i in 1 ... count + 1 {
        ch <- i * i
    }
    ch.Close()
}

func squares(count int32) in chan[int32] {
    let ch = chan[int32](2)
    go fill(ch, count)
    return ch
}

let source = squares(5)
while let v = <-source {
    Console.WriteLine(v)
}

let (afterClose, ok) = <-source
Console.WriteLine("closed: {0} {1}", afterClose, ok)
