// file: SpanIndexing.gs
//
// ADR-0056 §1/§2: span element access. A `ReadOnlySpan[T]` / `Span[T]` indexer
// returns `ref readonly T` / `ref T`; §1 auto-dereferences a ref return in
// rvalue position, so `s[i]` reads the element value (not a managed pointer),
// and a `Span[T]` element write `s[i] = v` stores through the returned `ref T`.
// Spans are stack-only (GS0219), so the span locals live inside functions and
// are exercised from top-level statements.

package GSharp.Samples.SpanIndexing

import System

// Read: a `ReadOnlySpan[int32]` indexed inside an arithmetic loop sum. The
// indexer returns `ref readonly int32` and auto-dereferences to `int32`.
func sumSpan(values []int32) int32 {
    var s ReadOnlySpan[int32] = values
    var total = 0
    var i = 0
    for i < s.Length {
        total = total + s[i]
        i = i + 1
    }

    return total
}

// Write: a `Span[int32]` element assignment stores through the `ref int32`
// returned by `get_Item`, then the elements are read back and summed.
func writeBack(values []int32) int32 {
    var s Span[int32] = values
    s[0] = 100
    s[2] = 300
    return s[0] + s[1] + s[2]
}

Console.WriteLine(sumSpan([]int32{10, 20, 30}))
Console.WriteLine(writeBack([]int32{1, 2, 3}))
