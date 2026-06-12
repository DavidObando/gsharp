// file: SwitchExpression.gs
//
// Phase C (close interpreter/emit gap): switch *expression* emit.
// Exercises constant, discard, type, property, relational, and list
// pattern arms all returning a unified result type.

package GSharp.Samples.SwitchExpression

import System

open class Shape { var Name string }
class Circle : Shape { var Radius int32 }
class Square : Shape { var Side int32 }

let nums = []int32{-3, 0, 1, 5, 101}
for n in nums {
  let label = switch n {
    case 0: "zero"
    case < 0: "neg"
    case > 100: "huge"
    default: "small-pos"
  }
  Console.WriteLine("$n -> $label")
}

func areaTag(s Shape) string {
  return switch s {
    case c is Circle: "circle"
    case sq is Square: "square"
    default: "shape"
  }
}

Console.WriteLine(areaTag(Circle{Name: "c", Radius: 1}))
Console.WriteLine(areaTag(Square{Name: "s", Side: 2}))

let xs = []int32{1, 2, 3}
let listLabel = switch xs {
  case [1, _, 3]: "bookended"
  case _: "other"
}
Console.WriteLine(listLabel)

data struct Pair { var A int32 var B int32 }
let p = Pair{A: 7, B: 7}
let pairLabel = switch p {
  case { A: 0, B: 0 }: "origin"
  case { A: 7, B: 7 }: "diag77"
  default: "other"
}
Console.WriteLine(pairLabel)
