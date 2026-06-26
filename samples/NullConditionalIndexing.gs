// file: NullConditionalIndexing.gs
// ADR-0073 / issue #710: demonstrates the new `a?[i]` null-conditional
// indexing operator. The receiver is evaluated exactly once; if it reads
// as nil, the whole expression is nil and the index sub-expression is NOT
// evaluated. Otherwise the indexer fires and the result is lifted to its
// nullable form.

package GSharp.Example.NullConditionalIndexing

import System
import System.Collections.Generic

var calls int32 = 0

func bump() ([]int32)? {
    calls = calls + 1
    return []int32{7, 8, 9}
}

func nilBump() ([]int32)? {
    calls = calls + 1
    return nil
}

func main() {
    // 1. Slice receiver. The first read indexes a live slice; the second
    // reads through a nil slice and short-circuits to nil.
    var live ([]int32)? = []int32{10, 20, 30}
    var first = live?[1]
    Console.WriteLine(first)

    var missing ([]int32)? = nil
    var firstMissing = missing?[0]
    if firstMissing == nil {
        Console.WriteLine("nil-slice")
    }

    // 2. CLR Dictionary receiver — exercises the BoundClrIndexExpression
    // path that backs `?[]` over user-defined indexers.
    var d Dictionary[string, int32]? = Dictionary[string, int32]()
    d.Add("k", 42)
    var hit = d?["k"]
    Console.WriteLine(hit)

    var d2 Dictionary[string, int32]? = nil
    var miss = d2?["k"]
    if miss == nil {
        Console.WriteLine("nil-map")
    }

    // 3. Receiver-evaluated-once. `bump` is a side-effecting receiver
    // producer — both the not-nil branch and the nil branch must invoke
    // the receiver expression exactly once per `?[...]` site.
    var bumped = bump()?[2]
    Console.WriteLine(bumped)
    Console.WriteLine(calls)

    var bumpedNil = nilBump()?[0]
    if bumpedNil == nil {
        Console.WriteLine("nil-bumped")
    }

    Console.WriteLine(calls)
}

main()


