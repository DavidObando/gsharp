// file: aspirational/Patterns.gs
//
// Phase 6.2 sample. Pattern matching is interpreter-only for now;
// emit is deferred with the same posture as Phase 5 surfaces.

package GSharp.Samples.Patterns

import System

let number = 7
let numericLabel = switch number {
  case < 0 -> "negative"
  case > 0 -> "positive"
  default -> "zero"
}

let values = []int{1, 2, 3}
let listLabel = switch values {
  case [1, _, 3] -> "bookended"
  case _ -> "other"
}

Console.WriteLine("$numericLabel / $listLabel")
