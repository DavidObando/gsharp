// file: NamedDelegate.gs
//
// ADR-0059 / issue #255: a user-declared named delegate type is emitted as a
// real CLR `sealed class MulticastDelegate`-derived TypeDef with runtime-
// implemented `.ctor(object, IntPtr)` and `Invoke(params...) ret` methods,
// so C# consumers see a conventional handler type (e.g. `MyHandler`) and so
// GSharp events can carry first-class custom delegate types instead of
// always projecting through `Action`/`Func`.
//
// This sample declares two named delegate types — one void-returning and
// one with a return value — assigns a `func(...)` literal to each, and
// invokes them.

package GSharp.Samples.NamedDelegate

import System

// `void`-returning named delegate.
type Greeter = delegate func(name string)

// Value-returning named delegate.
type Combine = delegate func(a int32, b int32) int32

// A `func` literal converts implicitly to the matching named delegate type,
// just like it converts to Action/Func today (issue #295).
var hello Greeter = func(name string) {
    Console.WriteLine("hello, " + name)
}

var sum Combine = func(a int32, b int32) int32 {
    return a + b
}

hello.Invoke("world")
Console.WriteLine(sum.Invoke(2, 40))
