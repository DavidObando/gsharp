// file: TryParseOutVar.gs
// ADR-0060: a user-defined function that takes an `out` parameter and is
// invoked with each of the four `out` argument shapes: legacy `&x`, the
// inline-declaration `out var n`, the read-only `out let n`, and the
// discard `out _`.

package GSharp.Example.TryParseOutVar

import System

func tryProduce(out result int32) bool {
    result = 42
    return true
}

// 1. Legacy back-compat: pass a pre-declared variable by address.
var slot = 0
var ok = tryProduce(&slot)
Console.WriteLine(slot)
Console.WriteLine(ok)

// 2. Inline `out var` declaration: introduces a fresh writable local.
tryProduce(out var fromVar)
Console.WriteLine(fromVar)

// 3. Inline `out let` declaration: introduces a fresh read-only local.
tryProduce(out let fromLet)
Console.WriteLine(fromLet)

// 4. Discard: the produced value is dropped.
tryProduce(out _)
Console.WriteLine("done")
