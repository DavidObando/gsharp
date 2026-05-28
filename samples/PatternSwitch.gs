// file: PatternSwitch.gs
//
// Phase B (close interpreter/emit gap): pattern-switch *statement* emit.
// Exercises constant, discard, relational, type, property, and list patterns
// end-to-end through gsc.

package GSharp.Samples.PatternSwitch

import System

type Animal open class { Name string }
type Dog class : Animal { Bark int32 }
type Cat class : Animal { Purr int32 }

func describe(n int32) {
  switch n {
    case 0 { Console.WriteLine("zero") }
    case < 0 { Console.WriteLine("negative") }
    case > 100 { Console.WriteLine("huge") }
    default { Console.WriteLine("positive small") }
  }
}

func name(a Animal) {
  switch a {
    case d is Dog { Console.WriteLine("dog ${d.Name} barks ${d.Bark}") }
    case c is Cat { Console.WriteLine("cat ${c.Name} purrs ${c.Purr}") }
    default { Console.WriteLine("unknown") }
  }
}

func shape(xs []int32) {
  switch xs {
    case [1, _, 3] { Console.WriteLine("bookended-3") }
    case [_] { Console.WriteLine("singleton") }
    default { Console.WriteLine("other") }
  }
}

type Point data struct { X int32 Y int32 }

func origin(p Point) {
  switch p {
    case { X: 0, Y: 0 } { Console.WriteLine("origin") }
    case { X: > 0, Y: > 0 } { Console.WriteLine("Q1") }
    default { Console.WriteLine("elsewhere") }
  }
}

describe(-5)
describe(0)
describe(7)
describe(250)
name(Dog{Name: "rex", Bark: 9})
name(Cat{Name: "ed", Purr: 4})
shape([]int32{1, 2, 3})
shape([]int32{42})
shape([]int32{9, 9})
origin(Point{X: 0, Y: 0})
origin(Point{X: 3, Y: 4})
origin(Point{X: -1, Y: 1})
