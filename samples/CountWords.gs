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
//   - Range iteration over both an array (`for w in words`) and a
//     CLR `IDictionary[K, V]` (`for k, v in counts`) via the
//     for-range lowerer (Phase 4 exit, part 3).
//   - Cross-feature use of string interpolation (Phase 1.1) and the
//     fixed-size array literal syntax (Phase 3.A.2).
//
// Runs on both backends. Originally landed under `samples/aspirational/`
// (PR #66) because the emit pipeline could not yet encode CLR
// constructors / member access / for-range. The emit-parity work in PRs
// #67+ closes that gap, so this sample is now part of the top-level
// emit conformance harness (SampleConformanceTests) in addition to its
// interpreter-side sibling CountWordsSampleTests.

package GSharp.Example.CountWords

import System
import System.Collections.Generic

var words = [12]string{
    "the", "quick", "brown", "fox", "jumps", "over",
    "the", "lazy", "dog", "the", "quick", "fox",
}

var counts = Dictionary[string, int32]()

for w in words {
    if counts.ContainsKey(w) {
        counts[w] = counts[w] + 1
    } else {
        counts[w] = 1
    }
}

for k, v in counts {
    Console.WriteLine("$k: $v")
}
