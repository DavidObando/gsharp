// inventory: PostIncrementExpression

package Corpus.Grid02

import System

shared class PostIncrementExpressionFixture {
    func Run() {
        var n = 5
        let observed = n++
        Console.WriteLine("PostIncrementExpression: observed=$observed after=$n")
    }
}
