// file: Select.gs
//
// Phase G exit sample. Exercises emitted select receive, send, default,
// and blocking WhenAny retry paths deterministically.

package GSharp.Samples.Select

import System
import System.Threading

func delayedSend(ch chan int) int {
    Thread.Sleep(10)
    ch <- 40
    return 0
}

let ready = make(chan int, 1)
ready <- 7
select {
case v := <-ready {
    Console.WriteLine("recv: $v")
}
}

let sendCh = make(chan int, 1)
select {
case sendCh <- 11 {
    Console.WriteLine("sent")
}
}
let sentValue = <-sendCh
Console.WriteLine(sentValue)

let empty = make(chan int, 1)
select {
case v := <-empty {
    Console.WriteLine("unexpected: $v")
}
default {
    Console.WriteLine("default")
}
}

let blocking = make(chan int)
scope {
    go delayedSend(blocking)
    select {
    case v := <-blocking {
        Console.WriteLine("blocked: $v")
    }
    }
}
