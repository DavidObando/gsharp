// inventory: DivideExpression

package Corpus.Grid02

import System

shared class DivideExpressionFixture {
    func Run() {
        let a = 7
        let b = 2
        let negative = -7
        let x = 7.0
        Console.WriteLine("DivideExpression: int=${a / b} negInt=${negative / b} double=${x / float64(b)}")
    }
}
