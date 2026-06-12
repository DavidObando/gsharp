// file: SmartCastExtensions.gs
// ADR-0069 addendum / issue #712: extends Kotlin-style smart cast to
// `||` short-circuit (De Morgan dual of `&&`) and `switch` arm
// discriminator binding (in-arm and post-switch lift).

package GSharp.Example.SmartCastExtensions

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

// `||` else-branch narrowing — De Morgan dual of `&&`. When the guard
// `!(a is Dog) || silent` is false, both operands were false, so `a`
// is `Dog` AND `silent` is false. The early-exit `return` lifts that
// narrowing into the rest of the function.
func GreetOrSilent(a Animal, silent bool) {
    if !(a is Dog) || silent {
        Console.WriteLine("skipped")
        return
    }

    Console.WriteLine(a.Bark())
}

// `||` right-operand narrowing — the right operand of `||` runs only
// when the left was false, so it sees `a` narrowed by the left's
// inverted condition.
func RunOrCheck(a Animal) bool {
    return !(a is Dog) || a.Bark() != ""
}

// `switch` arm narrowing — both the discriminator `a` (a parameter)
// and the bound arm variable `d` / `c` see the narrowed type inside
// the arm body. No explicit cast is required.
func DescribeAnimal(a Animal) string {
    var result string = ""
    switch a {
        case d is Dog {
            result = a.Bark()
        }
        case c is Cat {
            result = a.Purr()
        }
        default {
            result = a.Describe()
        }
    }
    return result
}

// Post-switch lift — when every non-exiting arm contributes the same
// narrowing and the switch is exhaustive (has a default), the binder
// lifts the narrowing into the rest of the enclosing block.
func MatchDogOnly(a Animal) {
    switch a {
        case c is Cat {
            return
        }
        case d is Dog {
            Console.WriteLine("matched dog")
        }
        default {
            return
        }
    }
    Console.WriteLine(a.Bark())
}

let rex Animal = Dog{Name: "Rex"}
let whiskers Animal = Cat{Name: "Whiskers"}

GreetOrSilent(rex, false)
GreetOrSilent(rex, true)
GreetOrSilent(whiskers, false)

Console.WriteLine(RunOrCheck(rex))
Console.WriteLine(RunOrCheck(whiskers))

Console.WriteLine(DescribeAnimal(rex))
Console.WriteLine(DescribeAnimal(whiskers))

MatchDogOnly(rex)
MatchDogOnly(whiskers)
