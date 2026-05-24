// file: aspirational/Enum.gs
//
// Phase 6.8 sample. Enums are interpreter-only for now; emit is deferred.

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
