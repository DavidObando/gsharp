// file: VariadicCarriers.gs
// ADR-0173 / issue #3627: generalized variadic carriers — `...X[T]` is
// semantically equivalent to C#13 `params X<T>`. The type after `...` is
// the CARRIER when it is a supported collection shape (List, the
// IEnumerable family, Span/ReadOnlySpan, or an explicit []T); any other
// type keeps the classic ADR-0101 element meaning with a slice carrier.
// Expanded call sites element-coerce and pack into the carrier; a single
// argument already convertible to the carrier passes through.

package GSharp.Example.VariadicCarriers

import System
import System.Collections.Generic

func totalClassic(values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}

func totalList(values ...List[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t + values.Count
}

func totalSpan(values ...ReadOnlySpan[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t + values.Length
}

func joinSeq(values ...IEnumerable[string]) string {
    return string.Join("+", values)
}

func run() {
    Console.WriteLine(totalClassic(1, 2, 3))
    Console.WriteLine(totalList(4, 5))
    Console.WriteLine(totalSpan(6, 7))
    Console.WriteLine(joinSeq("a", "b"))

    // Pass-through: an existing collection is forwarded, not re-packed.
    let existing = List[int32]()
    existing.Add(10)
    existing.Add(20)
    Console.WriteLine(totalList(existing))
}

run()
