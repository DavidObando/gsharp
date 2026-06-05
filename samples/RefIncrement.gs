// file: RefIncrement.gs
// ADR-0060: a user-defined function that takes a `ref` parameter and mutates
// the caller's variable through the managed pointer. The call site uses both
// the legacy `&x` form (back-compat) and the new explicit `ref x` modifier.

package GSharp.Example.RefIncrement

import System

func bump(ref counter int32, by int32) {
    counter = counter + by
}

var n = 5
bump(&n, 10)
Console.WriteLine(n)

bump(ref n, 7)
Console.WriteLine(n)
