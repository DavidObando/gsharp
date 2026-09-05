// file: DiscriminatedUnion.gs
// ADR-0078 / issue #725: payload-bearing enum cases form a discriminated
// union — the parser desugars `enum Shape { Circle(r float64); Square(s float64) }`
// into a sealed base class `Shape` and one subclass per case, so pattern
// matching and exhaustiveness checking fall out of the existing sealed-class
// machinery.

package GSharp.Samples.DiscriminatedUnion

import System

enum Shape {
    Circle(r float64);
    Square(s float64);
    Empty
}

func area(s Shape) float64 {
    return switch s {
        case c is Circle: c.r * c.r * 3.14159
        case sq is Square: sq.s * sq.s
        case _ is Empty: 0.0
    }
}

let c = Circle(2.0)
let sq = Square(3.0)
let e = Empty{}

Console.WriteLine(area(c))
Console.WriteLine(area(sq))
Console.WriteLine(area(e))
