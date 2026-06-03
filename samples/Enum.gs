// file: Enum.gs
//
// Phase 6.8 sample. Demonstrates enum type declarations with switch/arrow-pattern expressions.

package GSharp.Samples.Enum

import System

type Color enum { Red, Green, Blue }

let color = Color.Green
let label = switch color {
  case Color.Red -> "red"
  case Color.Green -> "green"
  default -> "blue"
}

Console.WriteLine(label)
