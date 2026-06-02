// file: RefStructGenericField.gs
//
// Issue #375 / ADR-0056 §4: a user `ref struct` embedding a *closed* constructed
// generic value-type field (`ReadOnlySpan[int32]`) must be laid out with its real
// layout and its members accessed by managed pointer. The field signature already
// encodes the real `ReadOnlySpan`1<int32>` (never erased to System.Object), so the
// remaining fault was the receiver of an instance member call on the value-type
// field being loaded by value (`ldfld`) instead of by address (`ldflda`): calling
// an instance method on a value type requires a `this` managed pointer, and pushing
// the value instead corrupted the stack (AccessViolationException). Reading
// `w.data.Length` now loads the field address and succeeds.
//
// Scope: closed generic value-type fields only. Element access (`span[i]`) is
// covered by a separate ADR-0056 work item; this sample exercises `.Length`.

package GSharp.Samples.RefStructGenericField

import System

type Window ref struct {
    data ReadOnlySpan[int32]
}

func firstLen(w Window) int32 {
    return w.data.Length
}

func Main() {
    var nums []int32 = []int32{10, 20, 30}
    var span ReadOnlySpan[int32] = nums
    var w Window = Window{data: span}
    Console.WriteLine(firstLen(w))
}
