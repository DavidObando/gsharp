// file: Select.gs
//
// Phase G exit sample. Exercises emitted select receive, send, default,
// and blocking WhenAny retry paths deterministically.

package GSharp.Samples.Select

import System
import System.Threading

func delayedSend(ch chan int32) int32 {
    Thread.Sleep(10)
    ch <- 40
    return 0
}

let ready = make(chan int32, 1)
ready <- 7
select {
case let v = <-ready {
    Console.WriteLine("recv: $v")
}
}

let sendCh = make(chan int32, 1)
select {
case sendCh <- 11 {
    Console.WriteLine("sent")
}
}
let sentValue = <-sendCh
Console.WriteLine(sentValue)

let empty = make(chan int32, 1)
select {
case let v = <-empty {
    Console.WriteLine("unexpected: $v")
}
default {
    Console.WriteLine("default")
}
}

let blocking = make(chan int32)
scope {
    go delayedSend(blocking)
    select {
    case let v = <-blocking {
        Console.WriteLine("blocked: $v")
    }
    }
}
