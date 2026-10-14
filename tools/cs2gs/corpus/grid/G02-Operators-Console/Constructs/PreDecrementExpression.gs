// inventory: PreDecrementExpression

package Corpus.Grid02

import System

shared class PreDecrementExpressionFixture {
    func Run() {
        var n = 5
        let observed = (n -= 1)
        Console.WriteLine("PreDecrementExpression: observed=$observed after=$n")
    }
}
