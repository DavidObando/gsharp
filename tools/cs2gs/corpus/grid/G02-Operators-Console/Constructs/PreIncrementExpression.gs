// inventory: PreIncrementExpression

package Corpus.Grid02

import System

shared class PreIncrementExpressionFixture {
    func Run() {
        var n = 5
        let observed = (n += 1)
        Console.WriteLine("PreIncrementExpression: observed=$observed after=$n")
    }
}
