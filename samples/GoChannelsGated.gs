// file: GoChannelsGated.gs
//
// Issue #722 / ADR-0082. End-to-end sample for the per-file gate on the
// Go-flavored concurrency surface. Every gated form below is exercised
// at least once — `chan T` (parameter and `make` clauses), `<-` send
// and `<-` receive, the `go` statement, the `select` statement with a
// receive-bind arm and a default arm, and the `close(ch)` built-in.
//
// The single line that makes all of this legal is the
// `import Gsharp.Extensions.Go` below the package declaration.
// Removing it makes the binder emit GS0316 for each gated form used
// here (anchored at the `go`, `chan`, `<-`, `select`, and `close`
// keywords respectively).
//
// The control flow is structured to be deterministic so the sample
// participates in the regular SampleConformance harness: the producer
// goroutine pre-populates a buffered channel and closes it from a
// scope, after which the main thread drains all the values plus one
// post-close zero, then exercises a select with a guaranteed-ready
// receive arm and a default arm on an empty channel.

package GSharp.Samples.GoChannelsGated

import System
import Gsharp.Extensions.Go

func producer(ch chan int32) int32 {
    ch <- 1
    ch <- 2
    ch <- 3
    close(ch)
    return 0
}

let ch = make(chan int32, 3)
scope {
    go producer(ch)
}

let a = <-ch
let b = <-ch
let c = <-ch
let d = <-ch
Console.WriteLine(a)
Console.WriteLine(b)
Console.WriteLine(c)
Console.WriteLine(d)

let ready = make(chan int32, 1)
ready <- 99
select {
case let v = <-ready {
    Console.WriteLine("recv: $v")
}
}

let empty = make(chan int32, 1)
select {
case let v = <-empty {
    Console.WriteLine("unexpected: $v")
}
default {
    Console.WriteLine("default")
}
}
