// file: ExtensionFunctions.gs
// Phase 3.B.6 / ADR-0019: extension functions. A Go-style receiver clause
// `func (recv T) Name(args) ret { ... }` declares a function that is
// invoked at the call site as if it were an instance method on the
// receiver type. Extensions apply to types owned by another package, CLR
// types, and primitives. Same-package user types now bind as methods with
// receivers (Phase 6.4).

package GSharp.Example.ExtensionFunctions

import System

func (value int32) Abs() int32 {
    if value < 0 {
        return -value
    }

    return value
}

func (value int32) Scale(factor int32) int32 {
    return value * factor
}

var n = -7
var one = 1
Console.WriteLine(n.Abs())
Console.WriteLine(one.Scale(10))
