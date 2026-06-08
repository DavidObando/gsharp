// file: EnumBitwise.gs
// Issue #534 (fixed): bitwise operators on CLR enums (`A | B`, `A & B`,
// `A ^ B`, `~A`) must lift through the underlying integer type.

package GSharp.Refactoring.EnumBitwise

import System
import System.IO

let mode = FileShare.Read | FileShare.Write
Console.WriteLine(mode)
let masked = mode & FileShare.Read
Console.WriteLine(masked)
let toggled = mode ^ FileShare.Read
Console.WriteLine(toggled)
