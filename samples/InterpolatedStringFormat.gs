// file: InterpolatedStringFormat.gs
// Issue #368 conformance fixture: alignment (`${x,width}`) and format
// (`${x:spec}`) clauses lowered to DefaultInterpolatedStringHandler, plus the
// #366 regression `${expr.GetType()}` (a boxed reference-typed hole) which must
// not crash. Output is culture-independent (integer alignment + hex format).

package InterpolatedStringFormat

let value = 255
let label = "hi"
let pi = 3.5

Console.WriteLine("hex=${value:X4}")
Console.WriteLine("right=[${label,5}]")
Console.WriteLine("left=[${label,-5}]")
Console.WriteLine("both=[${value,6:X2}]")
Console.WriteLine("type=${pi.GetType()}")
