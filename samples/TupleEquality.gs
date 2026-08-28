// file: TupleEquality.gs
// Issue #3501 / ADR-0171: tuple equality operators. `t1 == t2` compares
// element-wise (folded with `&&`; `!=` folds `||`), each operand evaluated
// exactly once, elements left-to-right with short-circuit — so a mismatched
// first element skips later element comparisons, witnessed here by a user
// operator that prints when invoked.

package GSharp.Example.TupleEquality

import System

struct Loud {
    var V int32
}

func (a Loud) operator ==(b Loud) bool {
    Console.WriteLine("loud")
    return a.V == b.V
}

func (a Loud) operator !=(b Loud) bool {
    Console.WriteLine("loud")
    return a.V != b.V
}

func mk(tag string) (int32, string) {
    Console.WriteLine("eval $tag")
    return (1, "x")
}

// Basic outcomes.
let a = (1, "x")
let b = (1, "x")
let c = (2, "x")
Console.WriteLine(a == b)
Console.WriteLine(a != c)

// Nested tuples recurse element-wise.
Console.WriteLine(((1, 2), "n") == ((1, 2), "n"))

// Operands are evaluated exactly once each.
Console.WriteLine(mk("L") == mk("R"))

// Short-circuit: first elements differ, the Loud comparison never runs...
Console.WriteLine((1, Loud{V: 5}) == (2, Loud{V: 5}))
// ...but runs (printing once) when the first elements match.
Console.WriteLine((1, Loud{V: 5}) == (1, Loud{V: 6}))
