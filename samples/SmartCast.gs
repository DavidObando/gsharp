// file: SmartCast.gs
// ADR-0069 / issue #700: Kotlin-style smart cast. After a successful
// `is` check on a local or parameter, the variable is automatically
// treated as the narrower type in the corresponding flow region — no
// explicit `as` cast is needed. The same narrowing is granted to the
// rest of an enclosing scope after an `!is` test that early-exits.

package GSharp.Example.SmartCast

import System

open class Animal {
    var Name string
    open func Describe() string {
        return Name
    }
}

class Dog : Animal {
    override func Describe() string {
        return Name + " (dog)"
    }

    func Bark() string {
        return Name + ": woof"
    }
}

class Cat : Animal {
    override func Describe() string {
        return Name + " (cat)"
    }

    func Purr() string {
        return Name + ": purr"
    }
}

// Positive narrowing: inside the `if` block `a` is treated as `Dog`,
// so `a.Bark()` resolves without an explicit cast.
func Greet(a Animal) {
    Console.WriteLine(a.Describe())
    if a is Dog {
        Console.WriteLine(a.Bark())
    }
}

// Early-exit narrowing: after `if a !is Dog { return }`, the rest of
// the function sees `a` as `Dog`.
func DogOnly(a Animal) {
    if a !is Dog {
        return
    }

    Console.WriteLine(a.Bark())
}

// `&&` short-circuits left-to-right, so the right operand binds with
// `a` already narrowed to `Dog`.
func MaybeBark(a Animal, loud bool) {
    if a is Dog && loud {
        Console.WriteLine(a.Bark())
    }
}

// Multi-arm narrowing inside a single function. Each `if` opens its
// own narrowing region; the narrowings do not collide.
func Speak(a Animal) {
    if a is Dog {
        Console.WriteLine(a.Bark())
    }

    if a is Cat {
        Console.WriteLine(a.Purr())
    }
}

let rex Animal = Dog{Name: "Rex"}
let whiskers Animal = Cat{Name: "Whiskers"}

Greet(rex)
Greet(whiskers)

DogOnly(rex)

MaybeBark(rex, true)
MaybeBark(rex, false)

Speak(rex)
Speak(whiskers)
