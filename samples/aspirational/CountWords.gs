// file: CountWords.gs
//
// Phase 4 exit sample. Exercises the CLR-interop features that landed
// across PRs #62–#65 in one cohesive program:
//
//   - `Dictionary[K, V]` instantiation via the generic BCL type-position
//     resolver (Phase 4.4 / ADR-0020) and the CLR constructor-call
//     binder (Phase 4 exit, part 1).
//   - Indexer read/write on a CLR map (`counts[w]`) and instance method
//     calls (`counts.ContainsKey(w)`) via the CLR member-access binder
//     (Phase 4 exit, part 2).
//   - Range iteration over both an array (`for w := range words`) and a
//     CLR `IDictionary[K, V]` (`for k, v := range counts`) via the
//     for-range lowerer (Phase 4 exit, part 3).
//   - Cross-feature use of string interpolation (Phase 1.1) and the
//     fixed-size array literal syntax (Phase 3.A.2).
//
// The sample is interpreter-only for now: the emit backend does not yet
// understand CLR constructor calls / member access / for-range (the
// Phase 3+4 CLR-interop work is interpreter-first by design). It
// therefore lives under `samples/aspirational/` and is excluded from
// the emit conformance harness (ADR-0010). A sibling
// `CountWordsSampleTests` runs it through the interpreter and diffs
// stdout against `CountWords.golden`.

package GSharp.Example.CountWords

import System
import System.Collections.Generic

var words = [12]string{
    "the", "quick", "brown", "fox", "jumps", "over",
    "the", "lazy", "dog", "the", "quick", "fox",
}

var counts = Dictionary[string, int]()

for w := range words {
    if counts.ContainsKey(w) {
        counts[w] = counts[w] + 1
    } else {
        counts[w] = 1
    }
}

for k, v := range counts {
    Console.WriteLine("$k: $v")
}
