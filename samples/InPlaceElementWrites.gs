// file: InPlaceElementWrites.gs
// Issue #3292: struct member writes through indexed array/slice elements are
// rooted at the element address (ldelema), so they mutate the stored element
// in place — simple, compound, and increment field writes, nested chains,
// property setters, and mutating method receivers — with side-effecting index
// expressions evaluated exactly once per write.

package GSharp.Example.InPlaceElementWrites

import System

struct Point {
    var X int32
    var Y int32

    prop Sum int32 {
        get {
            return X + Y
        }
    }

    prop Tagged int32 {
        get {
            return Y
        }
        set {
            Y = value
        }
    }

    func Bump() {
        this.X = this.X + 1
    }
}

struct Inner {
    var C int32
}

struct Outer {
    var B Inner
}

func idx() int32 {
    calls = calls + 1
    return 0
}

func grab()[]Point {
    return ss
}

// Simple field write through a fixed-array element.
var ps = [2]Point{}
ps[0].X = 7
Console.WriteLine(ps[0].X)

// Compound and increment flavors.
ps[0].X += 3
ps[0].X++
Console.WriteLine(ps[0].X)

// Nested value-typed chain over an element.
var os = [2]Outer{}
os[1].B.C = 42
Console.WriteLine(os[1].B.C)

// Slice elements are CLR-array backed and write in place too.
var ss = []Point{Point{}, Point{}}
ss[1].Y = 9
Console.WriteLine(ss[1].Y)

// Mutating method receiver operates on the stored element.
ps[1].Bump()
ps[1].Bump()
Console.WriteLine(ps[1].X)

// Property setter through an element mutates the stored element.
ss[0].Tagged = 5
Console.WriteLine(ss[0].Y)

// A side-effecting index expression fires exactly once per write.
var calls = 0
var rs = [2]Point{}
rs[idx()].X += 5
rs[idx()].X++
rs[idx()].Bump()
Console.WriteLine(rs[0].X)
Console.WriteLine(calls)

// `let` binds the variable, not the heap array: element writes stay legal.
let ls = [2]Point{}
ls[0].X = 11
Console.WriteLine(ls[0].X)

// The element write is visible through any alias of the backing array.
grab()[1].X = 13
Console.WriteLine(ss[1].X)
Console.WriteLine(ss[1].Sum)
