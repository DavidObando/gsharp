// file: UserRefStruct.gs
//
// Issue #367 (deferred follow-up): user-declared `ref struct` types. A `ref`
// modifier on a `struct` declaration marks the value type as by-ref-like; the
// emitter stamps it with `System.Runtime.CompilerServices.IsByRefLikeAttribute`
// (plus the C# compiler's `[Obsolete]` guard marker) so the CLR treats it as
// stack-only. The same escape rules enforced for imported ref structs (GS0219)
// apply: such a value cannot be boxed, stored in a field of a non-ref-struct,
// captured by a closure, hoisted into an async/iterator state machine, or used
// as a generic type argument. A `ref struct` may, however, hold by-ref-like
// fields (it is stack-only too). This sample exercises only the legal,
// stack-confined uses (ref-struct values live as locals inside functions).

package GSharp.Samples.UserRefStruct

import System

// A by-ref-like accumulator with a plain field, used as a stack-confined value.
type Accumulator ref struct {
    var Total int32
}

func add(acc Accumulator, n int32) Accumulator {
    return Accumulator{Total: acc.Total + n}
}

func runningTotal() int32 {
    var acc Accumulator = Accumulator{Total: 0}
    acc = add(acc, 5)
    acc = add(acc, 7)
    return acc.Total
}

// A by-ref-like aggregate that legally embeds another `ref struct` as a field —
// only permitted because the containing type is itself a `ref struct`.
type LabeledAccumulator ref struct {
    var Inner Accumulator
    var Label string
}

func describe(item LabeledAccumulator) string {
    return item.Label + "=" + item.Inner.Total.ToString()
}

func labeledSummary() string {
    var inner Accumulator = add(Accumulator{Total: 0}, 30)
    var item LabeledAccumulator = LabeledAccumulator{Inner: inner, Label: "score"}
    return describe(item)
}

Console.WriteLine(runningTotal())
Console.WriteLine(labeledSummary())
