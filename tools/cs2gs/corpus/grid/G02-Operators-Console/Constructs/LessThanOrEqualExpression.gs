// inventory: LessThanOrEqualExpression

package Corpus.Grid02

import System

shared class LessThanOrEqualExpressionFixture {
    func Run() {
        let a = 5
        let b = 5
        let le = a <= b
        let notLe = b + 1 <= a
        Console.WriteLine("LessThanOrEqualExpression: le=$le notLe=$notLe")
    }
}
