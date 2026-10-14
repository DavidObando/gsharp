// inventory: ExclusiveOrExpression

package Corpus.Grid02

import System

shared class ExclusiveOrExpressionFixture {
    func Run() {
        let a = 12
        let b = 10
        let p = true
        let q = false
        Console.WriteLine("ExclusiveOrExpression: int=${a ^ b} bool=${p ^ q}")
    }
}
