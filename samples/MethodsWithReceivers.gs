// file: MethodsWithReceivers.gs
//
// Instance methods on user-defined classes — declared in-body per ADR-0079
// (issue #719). The receiver-clause form (`func (p Point) Distance() ...`)
// is now reserved for non-owned receiver types; declarations on types this
// package owns belong in the type body. See also ADR-0024 (canonical
// methods-vs-extensions style).

package GSharp.Samples.MethodsWithReceivers

import System

class Point {
    var X int32
    var Y int32

    func Distance() int32 {
        return X * X + Y * Y
    }
}

let p = Point{X: 3, Y: 4}
Console.WriteLine(p.Distance())
