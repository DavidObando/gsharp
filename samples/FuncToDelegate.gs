// file: FuncToDelegate.gs
//
// Issue #295 (related to #255): a GSharp function value converts to a
// compatible CLR delegate type in ALL positions, not only as a direct call
// argument. This sample exercises the previously-rejected assignment and
// return positions (which used to fail with `error GS0155`), plus a
// func-typed value adapted to a named delegate type. The resulting delegates
// are invoked to prove the materialization is correct at runtime.

package GSharp.Samples.FuncToDelegate

import System

// Return position: a factory that RETURNS a delegate built from a func literal.
func makeDoubler() Func[int32, int32] {
    return func(x int32) int32 { return x * 2 }
}

// Assignment position: a func literal assigned to a named generic delegate.
var isBig Predicate[int32] = func(x int32) bool { return x > 2 }

// Assignment position: a func literal assigned to a parameterless delegate.
var greet Action = func() { Console.WriteLine("hello from Action") }

// A func-typed value adapted to a named delegate type (delegate adaptation).
var raw = func(x int32) int32 { return x + 100 }
var bump Func[int32, int32] = raw

var doubler = makeDoubler()

Console.WriteLine(doubler.Invoke(21))
Console.WriteLine(isBig.Invoke(5))
Console.WriteLine(isBig.Invoke(1))
greet.Invoke()
Console.WriteLine(bump.Invoke(1))
