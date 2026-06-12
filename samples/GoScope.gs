// file: GoScope.gs
//
// Phase F exit sample. Exercises emitted `go` statements registered with an
// enclosing `scope`: each goroutine captures the shared buffered channel,
// sends a value, and the scope waits before the main body drains the channel.

package GSharp.Samples.GoScope

import System
import Gsharp.Extensions.Go

func send(value int32, ch chan int32) int32 {
    ch <- value
    return 0
}

let ch = make(chan int32, 3)
scope {
    go send(1, ch)
    go send(2, ch)
    go send(3, ch)
}

let a = <-ch
let b = <-ch
let c = <-ch
Console.WriteLine(a + b + c)
