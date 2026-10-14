// inventory: AddExpression

package Corpus.Grid02

import System

shared class AddExpressionFixture {
    func Run() {
        let a = 7
        let b = 3
        let x = 1.25
        let y = 2.25
        let left = "cat"
        let joined = left + "-dog"
        let mixed = "n=" + a.ToString()
        Console.WriteLine("AddExpression: int=${a + b} double=${x + y}")
        Console.WriteLine("AddExpression: string=$joined mixed=$mixed")
    }
}
