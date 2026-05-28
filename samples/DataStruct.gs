// file: DataStruct.gs
// Phase 3.B.2 / ADR-0029: 'data struct' declarations introduce a value-typed
// aggregate whose instances compare with structural equality. The 'data'
// keyword is context-sensitive (only special before 'struct') and the
// compiled CLR type is a plain ValueType whose inherited reflection-based
// Equals/GetHashCode delivers the same semantics as the interpreter's
// field-by-field comparison.

package GSharp.Example.DataStruct

import System

type Point data struct {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = Point{X: 3, Y: 4}
var r = Point{X: 3, Y: 5}

Console.WriteLine(p == q)
Console.WriteLine(p != r)
Console.WriteLine(q == r)

var s = p
s.X = 99
Console.WriteLine(p == s)
