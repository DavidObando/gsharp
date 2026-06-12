// file: MethodGroupToDelegate.gs
// Issue #324: a named function used as a method group converts directly to a
// delegate value, mirroring the C#/F# idiom. This sample exercises every
// supported target shape: a generic `Func[...]`, the native `(...) -> R` type,
// passing a method group as a callback argument, and an `Action[...]` (void
// return). No lambda wrapping is required.

package GSharp.Example.MethodGroupToDelegate

import System

func inc(x int32) int32 {
    return x + 1
}

func twice(x int32) int32 {
    return x * 2
}

func apply(g (int32) -> int32, v int32) int32 {
    return g(v)
}

func shout(message string) {
    Console.WriteLine(message)
}

// Method group -> generic Func[...] delegate.
var f Func[int32, int32] = inc
Console.WriteLine(f.Invoke(41))

// Method group -> native (T) -> R delegate, invoked directly.
var nf (int32) -> int32 = twice
Console.WriteLine(nf(21))

// Method group passed as a callback argument.
Console.WriteLine(apply(inc, 9))

// Method group -> Action[...] delegate (void return).
var a Action[string] = shout
a.Invoke("method groups work")
