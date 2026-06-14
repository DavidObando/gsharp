// file: GsharpExtensionsMixed.gs
// Issue #724 / ADR-0084: end-to-end demo that chains Sequences builders /
// transformers with Optional helpers. Goal: show that the two namespaces
// compose naturally — produce a sequence, transform it, then collapse it
// through an Optional terminal that we further reshape with Map/OrElse.

package GSharp.Example.MixedExtensions

import System
import System.Linq
import System.Collections.Generic
import Gsharp.Extensions.Optional
import Gsharp.Extensions.Sequences

func sumOf(values IEnumerable[int32]) int32 {
    var total int32 = 0
    for v in values {
        total = total + v
    }
    return total
}

func tryLookup(dict map[string,string], key string) string? {
    if dict.ContainsKey(key) {
        return dict[key]
    }
    return nil
}

// Build an infinite powers-of-two sequence with Iterate, take a window, and
// pick the first one whose sum exceeds a threshold via Optional helpers.

let geom = Sequences.Iterate(1, func(n int32) int32 { return n * 2 })

let firstHeavyTrio = geom.Take(8).Windowed(3).Where(func(w IList[int32]) bool {
    return sumOf(w) > 50
}).FirstOrNil()

let heavySumText = firstHeavyTrio.Map(func(w IList[int32]) string { return sumOf(w).ToString() })
Console.WriteLine("first heavy trio sum: " + heavySumText.OrElse("<absent>"))

// Build a {first-letter -> word} map from a sequence and look up keys via
// Optional helpers (OrElse for the happy path, OrCompute for lazy default).

let words = Sequences.Of("alpha", "bravo", "charlie", "delta")
let byInitial = words.ToMap(
    func(s string) string { return s.Substring(0, 1) },
    func(s string) string { return s })

let presentHit string? = tryLookup(byInitial, "a")
let absentHit string? = tryLookup(byInitial, "z")
Console.WriteLine(presentHit.OrElse("<missing>"))
Console.WriteLine(absentHit.OrCompute(func() string { return "<computed default>" }))

// Streaming pipeline: Indexed -> filter to odd values -> Pairwise.

let streamed = Sequences.Range(0, 10).Indexed().Where(func(p (int32, int32)) bool {
    return p.Item2 % 2 == 1
}).Select(func(p (int32, int32)) int32 { return p.Item2 })

for delta in streamed.Pairwise() {
    Console.WriteLine(delta.Item1.ToString() + "->" + delta.Item2.ToString())
}
