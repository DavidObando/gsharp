// file: TupleSequenceIterators.gs
// Issue #813 / ADR-0084 §L5: iterator return types whose element type is a
// value-tuple (`sequence[(int32, T)]`, `sequence[(T, T)]`, …) now bind and
// emit verifier-clean state machines. This sample is the dogfood port of
// the `Indexed` / `Pairwise` shapes from `Gsharp.Extensions.Sequences`
// expressed entirely in G#, plus a tiny driver that closes both `T = int32`
// and `T = string`.

package GSharp.Example.TupleSequenceIterators

import System
import System.Collections.Generic

class Sequences {
    shared {
        // `(int32, T)` element type — the issue's `Indexed` spelling.
        func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }

        // `(T, T)` element type — the issue's `Pairwise` spelling.
        func Pairwise[T](source IEnumerable[T]) sequence[(T, T)] {
            var first = true
            var prev T = default(T)
            for v in source {
                if !first {
                    yield (prev, v)
                }
                prev = v
                first = false
            }
        }
    }
}

let ints = []int32{10, 20, 30}
let words = []string{"a", "b", "c"}

Console.WriteLine("Indexed[int32]:")
for p in Sequences.Indexed[int32](ints) {
    Console.WriteLine(p.Item1.ToString() + ":" + p.Item2.ToString())
}

Console.WriteLine("Indexed[string]:")
for p in Sequences.Indexed[string](words) {
    Console.WriteLine(p.Item1.ToString() + ":" + p.Item2)
}

Console.WriteLine("Pairwise[int32]:")
for p in Sequences.Pairwise[int32](ints) {
    Console.WriteLine(p.Item1.ToString() + "->" + p.Item2.ToString())
}

Console.WriteLine("Pairwise[string]:")
for p in Sequences.Pairwise[string](words) {
    Console.WriteLine(p.Item1 + "->" + p.Item2)
}
