// file: GsharpExtensionsSequences.gs
// Issue #724 / ADR-0084: idiomatic sequence builders and transformers from
// Gsharp.Extensions. Demonstrates Sequences.* builders (Range / RangeStep /
// Iterate / Repeat / Of / Empty) plus the extension transformers
// (Indexed / Windowed / Chunked / Pairwise / Interleave) and safe terminals
// (FirstOrNil / LastOrNil / SingleOrNil — single-name surface for both
// reference- and value-typed elements after ADR-0088),
// closing with the G#-shaped collectors ToSlice and ToMap.
// The Gsharp.Extensions.* namespaces are explicit-import only.

package GSharp.Example.SequencesHelpers

import System
import System.Linq
import System.Collections.Generic
import Gsharp.Extensions.Optional
import Gsharp.Extensions.Sequences

// --- Builders ----------------------------------------------------------------

Console.WriteLine("Range:")
for v in Sequences.Range(10, 5) {
    Console.WriteLine(v)
}

Console.WriteLine("RangeStep:")
for v in Sequences.RangeStep(0, 10, 3) {
    Console.WriteLine(v)
}

Console.WriteLine("Iterate (Take 5):")
let powers = Sequences.Iterate(1, func(n int32) int32 { return n * 2 }).Take(5)
for v in powers {
    Console.WriteLine(v)
}

Console.WriteLine("Repeat (Take 3):")
for v in Sequences.Repeat("x").Take(3) {
    Console.WriteLine(v)
}

Console.WriteLine("Of:")
for v in Sequences.Of("a", "b", "c") {
    Console.WriteLine(v)
}

Console.WriteLine("Empty.Any: " + Sequences.Empty[int32]().Any().ToString())

// --- Transformers ------------------------------------------------------------

let nums = Sequences.Range(1, 6)

Console.WriteLine("Indexed:")
for pair in nums.Indexed() {
    Console.WriteLine(pair.Item1.ToString() + "->" + pair.Item2.ToString())
}

Console.WriteLine("Windowed(3):")
for w in nums.Windowed(3) {
    Console.WriteLine(String.Join(",", w))
}

Console.WriteLine("Chunked(2):")
for c in nums.Chunked(2) {
    Console.WriteLine(String.Join(",", c))
}

Console.WriteLine("Pairwise:")
for p in nums.Pairwise() {
    Console.WriteLine(p.Item1.ToString() + "/" + p.Item2.ToString())
}

Console.WriteLine("Interleave:")
let evens = Sequences.RangeStep(2, 10, 2)
let odds = Sequences.RangeStep(1, 10, 2)
for v in evens.Interleave(odds) {
    Console.WriteLine(v)
}

// --- Safe terminals ----------------------------------------------------------

Console.WriteLine("FirstOrNil(names): " + (Sequences.Of("alpha", "beta").FirstOrNil() ?: "<none>"))
Console.WriteLine("FirstOrNil(empty): " + (Sequences.Empty[string]().FirstOrNil() ?: "<none>"))

Console.WriteLine("LastOrNil(names): " + (Sequences.Of("alpha", "beta").LastOrNil() ?: "<none>"))

Console.WriteLine("SingleOrNil(one): " + (Sequences.Of("solo").SingleOrNil() ?: "<none>"))
Console.WriteLine("SingleOrNil(many): " + (Sequences.Of("a", "b").SingleOrNil() ?: "<none>"))

// Value-type terminals share the canonical name with the reference-typed
// surface: ADR-0088 (issue #750) lets the binder honour generic constraints
// so `FirstOrNil` resolves to the struct overload on int sequences.
let firstVal = Sequences.Of(11, 22, 33).FirstOrNil()
Console.WriteLine("FirstOrNil(value): " + firstVal.OrElse(-1).ToString())

let lastVal = Sequences.Of(11, 22, 33).LastOrNil()
Console.WriteLine("LastOrNil(value): " + lastVal.OrElse(-1).ToString())

let solo = Sequences.Of(42).SingleOrNil()
Console.WriteLine("SingleOrNil(value, one): " + solo.OrElse(-1).ToString())

let manyVals = Sequences.Of(1, 2).SingleOrNil()
Console.WriteLine("SingleOrNil(value, many): " + manyVals.OrElse(-1).ToString())

// --- Collectors --------------------------------------------------------------

let slice = Sequences.Range(1, 4).ToSlice()
Console.WriteLine("ToSlice length: " + slice.Length.ToString())

let pairs = Sequences.Of(("one", 1), ("two", 2), ("three", 3))
let m1 = pairs.ToMap()
Console.WriteLine("ToMap(pairs)[two]: " + m1["two"].ToString())

let words = Sequences.Of("alpha", "beta", "gamma")
let m2 = words.ToMap(
    func(s string) string { return s.Substring(0, 1) },
    func(s string) int32 { return s.Length })
Console.WriteLine("ToMap(words)[a]: " + m2["a"].ToString())
