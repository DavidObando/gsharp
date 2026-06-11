// file: DataStructErgonomics.gs
// Phase 7.3 / ADR-0032: data-struct copy, with-expression, and deconstruction ergonomics.

package GSharp.Example.DataStructErgonomics

import System

type Point data struct {
    var x int32
    var y int32
}

let p = Point{x: 3, y: 4}
let same = p.copy()
let movedX = p.copy(x = 10)
let movedBoth = p.copy(x = 10, y = 20)
let viaWith = p with { x = 10 }
let (px, py) = p
let { y = namedY, x = namedX } = movedBoth

Console.WriteLine(p == same)
Console.WriteLine(movedX == viaWith)
Console.WriteLine(movedBoth.x)
Console.WriteLine(movedBoth.y)
Console.WriteLine(px + py)
Console.WriteLine(namedX + namedY)
