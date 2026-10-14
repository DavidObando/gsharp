// inventory: GreaterThanExpression

package Corpus.Grid02

import System

shared class GreaterThanExpressionFixture {
    func Run() {
        let a = 8
        let b = 3
        let gt = a > b
        let notGt = b > a
        Console.WriteLine("GreaterThanExpression: gt=$gt notGt=$notGt")
    }
}
