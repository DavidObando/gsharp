// file: SliceLinqUntypedLambda.gs
// Issue #1507: untyped arrow-lambda parameter inference now works for
// LINQ/extension methods invoked on slice/array (`[]T`, `[N]T`) receivers,
// matching the long-standing behaviour for `List[T]`. The lambda parameter
// type is recovered from the target delegate's element type, so no
// `(i Item)` annotation is required even though the receiver is a slice.

package GSharp.Example.SliceLinqUntypedLambda

import System
import System.Linq

data struct Item {
    var V int32
}

var xs = []Item{Item{V: 1}, Item{V: -2}, Item{V: 3}, Item{V: 4}}

// Untyped lambda over a slice receiver — `i` inferred as `Item`.
Console.WriteLine(xs.Where((i) -> i.V > 0).Count())

// Projection then terminal aggregate; `i` inferred as `Item`.
Console.WriteLine(xs.Select((i) -> i.V).Sum())

// Chained untyped lambdas, each intermediate an IEnumerable[Item].
Console.WriteLine(xs.Where((i) -> i.V > 0).Where((i) -> i.V < 4).Count())

// Primitive-element slice with OrderByDescending + First.
var ns = []int32{5, -1, 3, 8}
Console.WriteLine(ns.Where((x) -> x > 0).OrderByDescending((x) -> x).First())

// Fixed-length array (`[N]T`) receiver.
var arr = [3]Item{Item{V: 10}, Item{V: 20}, Item{V: -5}}
Console.WriteLine(arr.Where((i) -> i.V > 0).Select((i) -> i.V).Sum())

// String-element slice ordered by an untyped lambda projection.
var ss = []string{"apple", "kiwi", "fig"}
for s in ss.OrderBy((s) -> s.Length) {
    Console.WriteLine(s)
}
