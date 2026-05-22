// file: Class.gs
// Phase 3.B.3 (1/3): user-defined class types — declaration, composite literal,
// field read, field assignment, and reference semantics on assignment.
// Phase 3.B.3 (2/3, primary ctor): Kotlin-style primary constructor — params
// declare same-named public fields, called positionally via `Name(args)`.

package GSharp.Example.Class

import System

type Point class {
    X int
    Y int
}

var p = Point{X: 3, Y: 4}
Console.WriteLine(p.X + p.Y)

p.X = 10
Console.WriteLine(p.X)

var q = p
q.X = 99
Console.WriteLine(p.X)
Console.WriteLine(q.X)

var origin = Point{}
Console.WriteLine(origin.X + origin.Y)

type Vec class(X int, Y int) {
}

var v = Vec(5, 7)
Console.WriteLine(v.X + v.Y)
v.X = 100
Console.WriteLine(v.X + v.Y)

