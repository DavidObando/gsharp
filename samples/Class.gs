// file: Class.gs
// Phase 3.B.3 (1/3): user-defined class types — declaration, composite literal,
// field read, field assignment, and reference semantics on assignment.
// Phase 3.B.3 (2/3, primary ctor): Kotlin-style primary constructor — params
// declare same-named public fields, called positionally via `Name(args)`.

package GSharp.Example.Class

import System

type Point class {
    X int
    Y int
}

var p = Point{X: 3, Y: 4}
Console.WriteLine(p.X + p.Y)

p.X = 10
Console.WriteLine(p.X)

var q = p
q.X = 99
Console.WriteLine(p.X)
Console.WriteLine(q.X)

var origin = Point{}
Console.WriteLine(origin.X + origin.Y)

type Vec class(X int, Y int) {
}

var v = Vec(5, 7)
Console.WriteLine(v.X + v.Y)
v.X = 100
Console.WriteLine(v.X + v.Y)

// Phase 3.B.3 (2b/3): methods inside the class body with implicit `this`.
// Bare `X` inside `Sum`/`Scale` resolves to `this.X` (field access). The
// method dispatch is virtual under the hood (callvirt) for null safety.
type Pt class(X int, Y int) {
    func Sum() int {
        return X + Y
    }

    func Scale(factor int) {
        X = X * factor
        Y = Y * factor
    }
}

var pt = Pt(3, 4)
Console.WriteLine(pt.Sum())
pt.Scale(10)
Console.WriteLine(pt.Sum())

