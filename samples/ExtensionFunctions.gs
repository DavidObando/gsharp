// file: ExtensionFunctions.gs
// Phase 3.B.6 / ADR-0019: extension functions. A Go-style receiver clause
// `func (recv T) Name(args) ret { ... }` declares a function that is
// invoked at the call site as if it were an instance method on the
// receiver type. Extensions apply uniformly to user types and CLR types.

package GSharp.Example.ExtensionFunctions

import System

type Point struct {
    X int
    Y int
}

func (p Point) ManhattanLength() int {
    return abs(p.X) + abs(p.Y)
}

func (p Point) Scale(factor int) int {
    return (p.X + p.Y) * factor
}

func abs(value int) int {
    if value < 0 {
        return -value
    }

    return value
}

var p = Point{X: -3, Y: 4}
Console.WriteLine(p.ManhattanLength())
Console.WriteLine(p.Scale(10))
