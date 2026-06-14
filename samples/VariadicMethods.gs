// file: VariadicMethods.gs
// ADR-0102 / issue #812 — variadic parameters on the five member
// declaration sites lifted from ADR-0101's deferred list (class
// instance method, class static method in `shared { }`, interface
// method with default body, constructor, lambda). Each site exercises
// pack (N positional trailing args), pass-through (a single trailing
// []T), and the empty-pack call. Variadic on named delegate
// declarations is covered separately by samples/VariadicDelegate.gs.

package GSharp.Example.VariadicMethods

import System

class Joiner {
    func Join(sep string, parts ...string) string {
        var s = ""
        for var i = 0; i < parts.Length; i++ {
            if i > 0 { s = s + sep }
            s = s + parts[i]
        }
        return s
    }
}

class Sequences {
    shared {
        func Of[T](values ...T) []T {
            return values
        }
    }
}

interface IAdder {
    func Add(values ...int32) int32 {
        var total = 0
        for var i = 0; i < values.Length; i++ {
            total = total + values[i]
        }
        return total
    }
}

class Calc : IAdder {
}

class Tags {
    var Values []string
    init(vs ...string) {
        Values = vs
    }
    func Count() int32 {
        return Values.Length
    }
}

// (1) class instance method
let j = Joiner{}
Console.WriteLine(j.Join(", ", "a", "b", "c"))
Console.WriteLine(j.Join(", ", []string{"x", "y"}))
Console.WriteLine(j.Join(", "))

// (2) class static method in `shared { }`
let xs = Sequences.Of(1, 2, 3)
Console.WriteLine(xs.Length)
let arr = []int32{10, 20, 30}
let ys = Sequences.Of(arr)
Console.WriteLine(ys.Length)
let zs = Sequences.Of[int32]()
Console.WriteLine(zs.Length)

// (3) interface method via default body
let c = Calc{}
Console.WriteLine(c.Add(1, 2, 3, 4))
Console.WriteLine(c.Add([]int32{5, 6}))
Console.WriteLine(c.Add())

// (4) constructor (init)
let t = Tags("alpha", "beta", "gamma")
Console.WriteLine(t.Count())
let u = Tags([]string{"x", "y"})
Console.WriteLine(u.Count())
let v = Tags()
Console.WriteLine(v.Count())

// (5) lambda (function-literal form). The body sees []int32; the
// indirect call through a function-typed variable supplies a single
// []T argument explicitly (see ADR-0102 §5 caveat).
let pack = func(xs ...int32) int32 { return xs.Length }
Console.WriteLine(pack([]int32{7, 8, 9}))

let arrow = (xs ...int32) -> xs.Length
Console.WriteLine(arrow([]int32{1, 2}))
