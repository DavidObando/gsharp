// inventory: SubtractExpression

package Corpus.Grid02

import System

shared class SubtractExpressionFixture {
    func Run() {
        let a = 10
        let b = 4
        let x = 2.5
        let y = 0.25
        Console.WriteLine("SubtractExpression: int=${a - b} negative=${b - a + -1} double=${x - y}")
    }
}
