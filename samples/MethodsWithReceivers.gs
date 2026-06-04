// file: MethodsWithReceivers.gs
//
// Phase 6.4 sample. Same-package receiver declarations bind as methods on
// user-defined structs. Issue #409 promoted this sample out of aspirational/
// once the emit backend produced correct IL for value-type receivers.

package GSharp.Samples.MethodsWithReceivers

import System

type Point struct {
    X int32
    Y int32
}

func (p Point) Distance() int32 {
    return p.X * p.X + p.Y * p.Y
}

let p = Point{X: 3, Y: 4}
Console.WriteLine(p.Distance())
