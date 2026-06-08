// file: ShortCircuitOr.gs
// Wave-1 P0-1 family: short-circuit || must not evaluate the RHS when LHS is
// true. Pair with ShortCircuitAnd.gs to pin the dual lowering path.

package GSharp.Refactoring.ShortCircuitOr

import System

var counter = 0

func touch() bool {
    counter = counter + 1
    return true
}

let a = true || touch()
let b = false || touch()
Console.WriteLine(counter)
Console.WriteLine(a)
Console.WriteLine(b)
