// file: ShortCircuitAnd.gs
// Wave-1 P0-1 family: short-circuit && must not evaluate the RHS when LHS is
// false. Side-effecting RHS exercises the SideEffectSpiller (PR #476) so the
// captured byte sequence locks in the lowering shape that protects the RHS
// from being duplicated or eagerly executed.

package GSharp.Refactoring.ShortCircuitAnd

import System

var counter = 0

func touch() bool {
    counter = counter + 1
    return true
}

let a = false && touch()
let b = true && touch()
Console.WriteLine(counter)
Console.WriteLine(a)
Console.WriteLine(b)
