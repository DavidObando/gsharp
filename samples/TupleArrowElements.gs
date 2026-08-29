// file: TupleArrowElements.gs
// Issue #3639: a tuple TYPE may contain parenthesized function-type
// elements — `((int32) -> int32, (int32) -> int32)` — in declared types
// and in type-argument position. The parenthesized-nullable form
// `((T) -> R)?` keeps its ADR-0137 meaning: outer parens are the
// nullable-wrapping form only when the group holds exactly one function
// type (no top-level comma); with a comma they are a tuple type whose
// elements re-dispatch on the arrow look-ahead. Named elements (ADR-0172)
// compose: `(f (int32) -> int32, g () -> int32)`.

package GSharp.Example.TupleArrowElements

import System

func mk() ((int32) -> int32, (int32) -> int32) {
    return ((x int32) -> x + 1, (x int32) -> x * 2)
}

func mkZeroArg() (() -> int32, () -> int32) {
    return (() -> 10, () -> 32)
}

func mkNamed() (f (int32) -> int32, g () -> int32) {
    return ((x int32) -> x - 1, () -> 7)
}

let (a, b) = mk()
Console.WriteLine(a(1) + b(3))

let (c, d) = mkZeroArg()
Console.WriteLine(c() + d())

let named = mkNamed()
let f = named.f
let g = named.g
Console.WriteLine(f(10) + g())

let mixed ((int32) -> int32, int32) = ((x int32) -> x * x, 6)
let (square, n) = mixed
Console.WriteLine(square(n))

// The ADR-0137 parenthesized-nullable function type keeps its meaning.
var maybe ((int32) -> int32)? = nil
Console.WriteLine(maybe == nil)
