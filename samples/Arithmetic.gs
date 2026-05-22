// file: Arithmetic.gs
// Demonstrates Phase 2 (p2-langcov) emit coverage: locals, binary operators,
// user-defined functions with multi-character parameter names that contain
// digits (issue #32), and the synthesized top-level-statement entry point.

package GSharp.Example.Arithmetic

import System

func add(num1 int, num2 int) int {
    return num1 + num2
}

var sum = 0
for i := 1 ... 5 {
    sum = sum + i
}

Console.WriteLine(add(2, 3))
Console.WriteLine(sum)
