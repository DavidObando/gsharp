// file: SwitchExpression.gs
//
// Phase C (close interpreter/emit gap): switch *expression* emit.
// Exercises constant, discard, type, property, relational, and list
// pattern arms all returning a unified result type.

package GSharp.Samples.SwitchExpression

import System

type Shape open class { Name string }
type Circle class : Shape { Radius int }
type Square class : Shape { Side int }

let nums = []int{-3, 0, 1, 5, 101}
for n in nums {
  let label = switch n {
    case 0 -> "zero"
    case < 0 -> "neg"
    case > 100 -> "huge"
    default -> "small-pos"
  }
  Console.WriteLine("$n -> $label")
}

func areaTag(s Shape) string {
  return switch s {
    case c is Circle -> "circle"
    case sq is Square -> "square"
    default -> "shape"
  }
}

Console.WriteLine(areaTag(Circle{Name: "c", Radius: 1}))
Console.WriteLine(areaTag(Square{Name: "s", Side: 2}))

let xs = []int{1, 2, 3}
let listLabel = switch xs {
  case [1, _, 3] -> "bookended"
  case _ -> "other"
}
Console.WriteLine(listLabel)

type Pair data struct { A int B int }
let p = Pair{A: 7, B: 7}
let pairLabel = switch p {
  case { A: 0, B: 0 } -> "origin"
  case { A: 7, B: 7 } -> "diag77"
  default -> "other"
}
Console.WriteLine(pairLabel)
