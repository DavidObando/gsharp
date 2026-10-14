// inventory: ModuloExpression

package Corpus.Grid02

import System

shared class ModuloExpressionFixture {
    func Run() {
        let a = 7
        let b = 3
        let negative = -7
        let x = 7.5
        Console.WriteLine("ModuloExpression: int=${a % b} negInt=${negative % b} double=${x % 2.0}")
    }
}
