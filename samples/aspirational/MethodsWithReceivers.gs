// file: aspirational/MethodsWithReceivers.gs
//
// Phase 6.4 sample. Same-package receiver declarations bind as methods.

package GSharp.Samples.MethodsWithReceivers

import System

type Point struct {
    X int
    Y int
}

func (p Point) Distance() int {
    return p.X * p.X + p.Y * p.Y
}

let p = Point{X: 3, Y: 4}
Console.WriteLine(p.Distance())
