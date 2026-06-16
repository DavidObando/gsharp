// file: Class.gs
// Phase 3.B.3 (1/3): user-defined class types — declaration, composite literal,
// field read, field assignment, and reference semantics on assignment.
// Phase 3.B.3 (2/3, primary ctor): Kotlin-style primary constructor — params
// declare same-named public fields, called positionally via `Name(args)`.

package GSharp.Example.Class

import System

class Point {
    var X int32
    var Y int32
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

class Vec(X int32, Y int32) {
}

var v = Vec(5, 7)
Console.WriteLine(v.X + v.Y)
v.X = 100
Console.WriteLine(v.X + v.Y)

// Phase 3.B.3 (2b/3): methods inside the class body with implicit `this`.
// Bare `X` inside `Sum`/`Scale` resolves to `this.X` (field access). The
// method dispatch is virtual under the hood (callvirt) for null safety.
class Pt(X int32, Y int32) {
    func Sum() int32 {
        return X + Y
    }

    func Scale(factor int32) {
        X = X * factor
        Y = Y * factor
    }
}

var pt = Pt(3, 4)
Console.WriteLine(pt.Sum())
pt.Scale(10)
Console.WriteLine(pt.Sum())

// Phase 3.B.3 (3/3): open / override + single inheritance per ADR-0017.
// Sealed-by-default — `open` opts a class in to subclassing, `override`
// redefines an open inherited method. Virtual dispatch routes through
// the derived override at runtime. Phase 3 does not yet forward derived
// primary ctors to base ctors; the sample uses composite literals to
// initialize inherited fields directly.
open class Animal {
    var Kind string
    open func Speak() string {
        return "..."
    }

    func Label() string {
        return Kind
    }
}

class Dog : Animal {
    override func Speak() string {
        return "Woof"
    }
}

var dog = Dog{Kind: "dog"}
Console.WriteLine(dog.Label())
Console.WriteLine(dog.Speak())

var unknown = Animal{Kind: "mystery"}
Console.WriteLine(unknown.Speak())

// Phase 3.B.4: interfaces — signature-only contracts (ADR-0018). A class
// implements one or more interfaces via the `:` clause (after the optional
// base class). Calls through an interface-typed receiver dispatch to the
// runtime type's implementation.
interface IShape {
    func Area() int32;
}

class Square(Side int32) : IShape {
    func Area() int32 {
        return Side * Side
    }
}

var sq = Square(4)
Console.WriteLine(sq.Area())

