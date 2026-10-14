// inventory: TupleExpression

package Corpus.Grid05

import System
import System.Collections.Generic

shared class TupleExpressionFixture {
    func Run() {
        let t = (2, "two")
        Console.WriteLine("TupleExpression: items=${t.Item1},${t.Item2}")
        let pair = (Count: 3, Name: "three")
        Console.WriteLine("TupleExpression: named=${pair.Count},${pair.Name}")
        // Deconstruction with var (a, b).
        let (a, b) = t
        Console.WriteLine("TupleExpression: deconstructed=$a,$b")
        // Deconstruction-ASSIGNMENT to existing locals (issue #1895): a
        // swap spills the whole RHS once via `let (t0, t1) = rhs` then
        // writes back element-wise, so aliasing is handled correctly.
        var swapA = 10
        var swapB = 20
        swapA, swapB = swapB, swapA
        Console.WriteLine("TupleExpression: swapped=$swapA,$swapB")
        // Nested tuple.
        let nested = ((1, 2), "pair")
        Console.WriteLine("TupleExpression: nested=${nested.Item1.Item1},${nested.Item1.Item2},${nested.Item2}")
        // Issue #1922: foreach over a tuple-deconstructing pattern
        // translates to G#'s first-class `for (a, b) in xs` header.
        let pairs = List[(Name string, Score int32)]{("alice", 1), ("bob", 2)}
        for (name, score) in pairs {
            Console.WriteLine("TupleExpression: foreach=$name,$score")
        }
    }
}
