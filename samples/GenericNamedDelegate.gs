// file: GenericNamedDelegate.gs
//
// Issue #1503 (ADR-0059 follow-up): a GENERIC user-declared named delegate
// type is emitted as a real CLR generic `sealed class MulticastDelegate`-
// derived TypeDef. The delegate carries one `GenericParam` row per type
// parameter, threaded through its runtime-implemented `.ctor(object, IntPtr)`
// and `Invoke(params...) ret` signatures (referenced as `VAR(idx)` slots), so
// C# consumers see a conventional generic handler type and a `func(...)`
// literal converts to a constructed instantiation such as `Predicate[int32]`.
//
// This sample declares a single-type-parameter generic delegate, a
// multi-type-parameter one, and one whose type parameter appears inside a
// composite (`[]T`) parameter/return type; it constructs each from a `func`
// literal over a concrete type argument and invokes it.

package GSharp.Samples.GenericNamedDelegate

import System

// Single type parameter, used in parameter position.
type Predicate[T any] = delegate func(value T) bool

// Two type parameters: one in parameter position, one in return position.
type Converter[TIn any, TOut any] = delegate func(x TIn) TOut

// Type parameter nested inside a composite type (`[]T`) in both positions.
type Mapper[T any] = delegate func(items []T) []T

var isPositive Predicate[int32] = func(value int32) bool {
    return value > 0
}

var toLabel Converter[int32, string] = func(x int32) string {
    return "n=" + x.ToString()
}

var identity Mapper[int32] = func(items []int32) []int32 {
    return items
}

Console.WriteLine(isPositive.Invoke(7))
Console.WriteLine(isPositive.Invoke(-3))
Console.WriteLine(toLabel.Invoke(42))

let mapped = identity.Invoke([]int32{1, 2, 3})
Console.WriteLine(mapped[2])
