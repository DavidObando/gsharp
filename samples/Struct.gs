// file: Struct.gs
// Phase 3.B.1: user-defined struct types — declaration, composite literal,
// field read, field assignment, and Go-style value semantics on assignment.

package GSharp.Example.Struct

import System

type Point struct {
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
