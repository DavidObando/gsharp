// file: RefStructSpan.gs
//
// Issue #367: consuming a CLR by-ref-like (`ref struct`) type. `ReadOnlySpan[T]`
// carries `System.Runtime.CompilerServices.IsByRefLikeAttribute`, so the binder
// recognises it as stack-only: a local of that type is permitted and the emitted
// local signature is correct, but boxing it, storing it in a field, capturing it
// in a closure, or hoisting it into an async/iterator state machine is rejected
// (GS0219). This sample exercises only the legal, stack-confined uses.

package GSharp.Samples.RefStructSpan

import System

// A `ReadOnlySpan[char]` local viewing a string, sliced and materialised back to
// a string without ever escaping the stack.
func firstThree(text string) string {
    var span ReadOnlySpan[char] = text.AsSpan()
    var slice ReadOnlySpan[char] = span.Slice(0, 3)
    return slice.ToString()
}

// A `ReadOnlySpan[int32]` local over an array, read for its length.
func spanLength(values []int32) int32 {
    var span ReadOnlySpan[int32] = values
    return span.Length
}

Console.WriteLine(firstThree("hello world"))
Console.WriteLine(spanLength([]int32{10, 20, 30}))
