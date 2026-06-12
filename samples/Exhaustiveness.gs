// file: Exhaustiveness.gs
//
// Phase 6.3 sample. Enum switch expressions may omit default when all
// members are covered explicitly.

package GSharp.Samples.Exhaustiveness

import System

type Color enum { Red, Green, Blue }

let color = Color.Green
let label = switch color {
  case Color.Red: "red"
  case Color.Green: "green"
  case Color.Blue: "blue"
}

Console.WriteLine("color is $label")
