// inventory: PostDecrementExpression

package Corpus.Grid02

import System

shared class PostDecrementExpressionFixture {
    func Run() {
        var n = 5
        let observed = n--
        Console.WriteLine("PostDecrementExpression: observed=$observed after=$n")
    }
}
