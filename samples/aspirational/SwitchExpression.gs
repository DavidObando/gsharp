// file: aspirational/SwitchExpression.gs
//
// Phase 6.1 sample. Switch expressions are interpreter-only for now;
// emit is deferred with the same posture as Phase 5 surfaces.

package GSharp.Samples.SwitchExpression

import System

let count = 2
let label = switch count {
  case 0 -> "zero"
  case 1 -> "one"
  default -> "many"
}

Console.WriteLine("count is $label")
