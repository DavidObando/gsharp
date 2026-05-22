// file: InterpolatedString.gs
// Phase 1.1 conformance fixture: `$ident`, `${expr}`, and `$$` escape.

package InterpolatedString

let name = "world"
let n = 6
Console.WriteLine("Hello, $name!")
Console.WriteLine("answer = ${n * 7}")
Console.WriteLine("$$ stays literal")
