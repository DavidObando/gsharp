// file: Operators.gs
// Stream D / ADR-0035: receiver-form `operator` keyword on a GSharp struct.
// Defines binary `+`, binary `==` / `!=`, and unary `-` on Vector2 and uses
// them at call sites just like built-in operator syntax.
package GSharp.Sample.Operators

import System

type Vector2 class {
    X int32
    Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}

func (a Vector2) operator ==(b Vector2) bool {
    return a.X == b.X && a.Y == b.Y
}

func (a Vector2) operator !=(b Vector2) bool {
    return a.X != b.X || a.Y != b.Y
}

var p = Vector2{X: 1, Y: 2}
var q = Vector2{X: 3, Y: 4}
var r = p + q
var n = -p

Console.WriteLine(r.X)
Console.WriteLine(r.Y)
Console.WriteLine(n.X)
Console.WriteLine(n.Y)
Console.WriteLine(p == q)
Console.WriteLine(p != q)
Console.WriteLine(p == Vector2{X: 1, Y: 2})
