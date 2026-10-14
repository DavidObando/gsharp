// inventory: RightShiftExpression

package Corpus.Grid02

import System

shared class RightShiftExpressionFixture {
    func Run() {
        let value = 32
        let negative = -8
        Console.WriteLine("RightShiftExpression: a=${value >> 2} arithmetic=${negative >> 1}")
    }
}
