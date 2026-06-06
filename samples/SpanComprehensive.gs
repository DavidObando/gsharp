// file: SpanComprehensive.gs
//
// Issue #344 (ADR-0056 §Follow-ups): comprehensive `ReadOnlySpan[T]` / `Span[T]`
// validation. These are ref structs that demonstrate all the Level 2 capabilities
// from ADR-0056 - the originally-motivating high-performance buffer APIs from #344.

package GSharp.Samples.SpanComprehensive

import System

// Implicit []int32 → ReadOnlySpan[int32] conversion at call site (ADR-0056 §3).
func sumSpan(s ReadOnlySpan[int32]) int32 {
    var total = 0
    var i = 0
    for i < s.Length {
        total = total + s[i]  // Ref-returning indexer auto-dereference (§1/§2)
        i = i + 1
    }
    return total
}

// Implicit []int32 → Span[int32] conversion with write (§2/§3).
func doubleElements(s Span[int32]) {
    var i = 0
    for i < s.Length {
        s[i] = s[i] * 2  // Write through ref-returning indexer
        i = i + 1
    }
}

func Main() {
    // Create slice and pass to ReadOnlySpan parameter - implicit conversion.
    var nums = []int32{10, 20, 30}
    Console.WriteLine(sumSpan(nums).ToString())

    // Create slice, pass to Span parameter, modify through ref indexer.
    var values = []int32{5, 10, 15}
    doubleElements(values)
    Console.WriteLine(values[0].ToString())  // Should be 10

    // Multiple ref struct locals without GS0219 escape errors.
    var span1 ReadOnlySpan[int32] = values
    var span2 = span1.Slice(1, 2)
    Console.WriteLine(span2.Length.ToString())  // Should be 2
}
