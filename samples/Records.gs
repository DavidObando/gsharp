// file: Records.gs
// Phase 6.7 / ADR-0025: 'record' is a context-sensitive alias for
// 'data struct'. This sample intentionally mirrors DataStruct.gs with the
// same observable structural-equality behavior.

package GSharp.Example.Records

import System

type Point record {
    X int
    Y int
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
