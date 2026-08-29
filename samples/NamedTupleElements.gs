// file: NamedTupleElements.gs
// ADR-0172: named tuple elements. Types name elements name-first —
// `(line int32, column int32)` — and literals label with a colon —
// `(line: 1, column: 2)`. Names are metadata over the positional shape:
// access by name resolves to the position (ItemN stays valid), same-shape
// tuples differing only in names are identity-convertible, and equality
// (ADR-0171) ignores names.

package GSharp.Example.NamedTupleElements

import System

func divmod(a int32, b int32) (quotient int32, remainder int32) {
    return a / b, a % b
}

let pos (line int32, column int32) = (3, 5)
Console.WriteLine(pos.line)
Console.WriteLine(pos.column)
Console.WriteLine(pos.Item1)

let labeled = (line: 7, column: 9)
Console.WriteLine(labeled.line + labeled.column)

let unnamed (int32, int32) = pos
Console.WriteLine(unnamed.Item2)

let r = divmod(17, 5)
Console.WriteLine("${r.quotient} rem ${r.remainder}")

let nested (inner (a int32, b int32), tag string) = ((a: 1, b: 2), "x")
Console.WriteLine(nested.inner.b)

Console.WriteLine(pos == (3, 5))
