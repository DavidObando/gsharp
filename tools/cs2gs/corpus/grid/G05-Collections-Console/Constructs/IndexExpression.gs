// inventory: IndexExpression

package Corpus.Grid05

import System

shared class IndexExpressionFixture {
    func Run() {
        let a[]int32 = []int32{1, 2, 3, 4, 5}
        Console.WriteLine("IndexExpression: last=${a[^1]} secondLast=${a[^2]}")
        // ADR-0187 / issue #4350: a saved System.Index is a first-class
        // G# value, so `Index third = ^3; a[third]` keeps from-end meaning.
        let third = ^3
        Console.WriteLine(
            "IndexExpression: third=${a[third]} fromEnd=${third.IsFromEnd} offset=${third.GetOffset(a.Length)}"
        )
        let word = "gsharp"
        Console.WriteLine("IndexExpression: lastChar=${word[^1]}")
    }
}
