// inventory: GreaterThanOrEqualExpression

package Corpus.Grid02

import System

shared class GreaterThanOrEqualExpressionFixture {
    func Run() {
        let a = 5
        let b = 5
        let ge = a >= b
        let notGe = a >= b + 1
        Console.WriteLine("GreaterThanOrEqualExpression: ge=$ge notGe=$notGe")
    }
}
