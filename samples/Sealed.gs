// file: Sealed.gs
// ADR-0078: `sealed class` declares a closed class hierarchy where every
// subclass is known at compile time. The switch expression below is checked
// for exhaustiveness — adding a new shape without an arm produces GS0313.

package GSharp.Samples.Sealed

import System

sealed class Shape {
}

class Circle : Shape {
    var Radius float64
}

class Square : Shape {
    var Side float64
}

func area(s Shape) float64 {
    return switch s {
        case c is Circle: c.Radius * c.Radius * 3.14159
        case sq is Square: sq.Side * sq.Side
    }
}

let c = Circle{Radius: 2.0}
let sq = Square{Side: 3.0}

Console.WriteLine(area(c))
Console.WriteLine(area(sq))
