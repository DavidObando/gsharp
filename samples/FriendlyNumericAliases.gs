// file: FriendlyNumericAliases.gs
//
// ADR-0098 / issue #729 — friendly numeric type aliases. The aliases
// `int`, `long`, `byte`, `float`, … resolve at the binder layer to the
// canonical width-bearing TypeSymbols (`int32`, `int64`, `uint8`,
// `float32`, …), so this sample intentionally mixes the two spellings
// across function boundaries to demonstrate they are interchangeable.
// Canonical names remain preferred for documentation and library APIs;
// the friendly aliases are appropriate for local code where brevity
// helps reading.

package FriendlyNumericAliases

import System

func sumAlias(a int, b int) int { return a + b }
func sumCanonical(a int32, b int32) int32 { return a + b }

func bytesPerWord(w byte) int { return int(w) * int(w) }

func widen(s short, l long) long { return long(s) + l }

func averageFloat(a float, b float) float { return (a + b) / 2.0F }

func averageDouble(a double, b double) double { return (a + b) / 2.0 }

let x int = sumAlias(2, 3)
let y int32 = sumCanonical(x, 4)
Console.WriteLine(y)

let w byte = uint8(5)
Console.WriteLine(bytesPerWord(w))

let s short = int16(10)
let l long = 1000L
Console.WriteLine(widen(s, l))

Console.WriteLine(averageFloat(1.0F, 3.0F))
Console.WriteLine(averageDouble(2.0, 6.0))
