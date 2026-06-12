// file: ExplicitConstructor.gs
// Issue #306: a GSharp `class` may declare a standalone user-defined constructor
// via the `init(params) [: base(args)] { ... }` form. Unlike the Kotlin-style
// primary constructor (which only declares same-named fields and implicitly
// chains to a parameterless base ctor), an `init` constructor has an explicit
// body of statements, sees `this`, its parameters, and the class's fields by
// bare name, and may chain to a specific base constructor.
//
// This sample proves the scenario end-to-end:
//   * an `init` body assigns fields and computes derived state
//   * the body may contain control flow
//   * an `init` may chain to a GSharp base class's primary constructor
//   * an `init` may chain to a CLR base (System.Exception) lacking a
//     parameterless constructor, then run its own body

package GSharp.Example.ExplicitConstructor

import System

// A class whose explicit constructor runs arbitrary statements: it assigns the
// `Width`/`Height` fields and computes the derived `Area` field.
class Rect {
    var Width int32
    var Height int32
    var Area int32

    init(w int32, h int32) {
        Width = w
        Height = h
        Area = w * h
    }
}

var r = Rect(3, 4)
Console.WriteLine(r.Width)
Console.WriteLine(r.Height)
Console.WriteLine(r.Area)

// The constructor body may contain control flow.
class Clamped {
    var Value int32

    init(v int32) {
        if v < 0 {
            Value = 0
        } else {
            Value = v
        }
    }
}

Console.WriteLine(Clamped(-5).Value)
Console.WriteLine(Clamped(7).Value)

// An `init` constructor can chain to a GSharp base class's primary constructor
// and then run its own body.
open class Animal(Name string) {
    func Speak() string {
        return Name
    }
}

class Dog : Animal {
    var Tricks int32

    init(name string, tricks int32) : base(name) {
        Tricks = tricks
    }
}

var d = Dog("Rex", 3)
Console.WriteLine(d.Speak())
Console.WriteLine(d.Name)
Console.WriteLine(d.Tricks)

// An `init` constructor can chain to a CLR base (System.Exception) whose
// constructors all require arguments, then run its own body.
class MyError : Exception {
    var Code int32

    init(message string, code int32) : base(message) {
        Code = code
    }
}

var e = MyError("boom", 42)
Console.WriteLine(e.Message)
Console.WriteLine(e.Code)
