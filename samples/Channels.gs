// file: Channels.gs
//
// Phase E exit sample. Exercises the channel emit path landed in this PR
// without yet requiring goroutines (Phase F) or select (Phase G): create a
// buffered channel, send values into it, drain them in source order, then
// close it and observe the closed-channel default value via receive.

package GSharp.Samples.Channels

import System

let ch = make(chan int32, 3)
ch <- 1
ch <- 2
ch <- 3
close(ch)

let a = <-ch
let b = <-ch
let c = <-ch
let d = <-ch

Console.WriteLine(a)
Console.WriteLine(b)
Console.WriteLine(c)
Console.WriteLine(d)
