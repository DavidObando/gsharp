// file: Patterns.gs
//
// Phase 6.2 sample. Pattern matching originally landed interpreter-only
// under samples/aspirational/; it was promoted here once emit caught up.

package GSharp.Samples.Patterns

import System

let number = 7
let numericLabel = switch number {
    case < 0: "negative"
    case > 0: "positive"
    default: "zero"
}

let values = []int32{1, 2, 3}
let listLabel = switch values {
    case [1, _, 3]: "bookended"
    case _: "other"
}

Console.WriteLine("$numericLabel / $listLabel")
