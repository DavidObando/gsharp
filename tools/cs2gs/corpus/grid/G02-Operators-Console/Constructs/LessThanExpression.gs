// inventory: LessThanExpression

package Corpus.Grid02

import System

shared class LessThanExpressionFixture {
    func Run() {
        let a = 2
        let b = 9
        let lt = a < b
        let notLt = b < a
        Console.WriteLine("LessThanExpression: lt=$lt notLt=$notLt")
    }
}
