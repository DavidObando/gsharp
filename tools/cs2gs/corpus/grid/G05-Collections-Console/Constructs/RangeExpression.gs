// Issue #1896: range-index forms (a[1..3], a[..2], a[^2..], a[..],
// "gsharp"[1..4]) now lower to gsc's own native range-index syntax instead of
// the unresolvable <receiver>.Slice(...) desugaring.

package Corpus.Grid05

import System

shared class RangeExpressionFixture {
    func Run() {
        let a[]int32 = []int32{1, 2, 3, 4, 5, 6}
        let mid = a[1 .. 3]
        Console.WriteLine("RangeExpression: mid=${string.Join(",", mid)}")
        let head = a[.. 2]
        Console.WriteLine("RangeExpression: head=${string.Join(",", head)}")
        let tail = a[^2 ..]
        Console.WriteLine("RangeExpression: tail=${string.Join(",", tail)}")
        let endTrim = a[1 .. ^1]
        Console.WriteLine("RangeExpression: endTrim=${string.Join(",", endTrim)}")
        let allButLast = a[.. ^1]
        Console.WriteLine("RangeExpression: allButLast=${string.Join(",", allButLast)}")
        let all = a[..]
        Console.WriteLine("RangeExpression: allLen=${all.Length}")
        let sliced = "gsharp" [1 .. 4]
        Console.WriteLine("RangeExpression: sliced=$sliced")
        // ADR-0187 / issue #4350: reusable System.Range values, including a
        // leading from-end bound, round-trip as readable G# range values.
        let trimmed = ^4 .. ^1
        let saved = a[trimmed]
        Console.WriteLine("RangeExpression: saved=${string.Join(",", saved)} complement=${~5}")
    }
}
