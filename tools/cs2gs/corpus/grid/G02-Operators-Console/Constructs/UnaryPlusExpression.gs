// inventory: UnaryPlusExpression

package Corpus.Grid02

import System

shared class UnaryPlusExpressionFixture {
    func Run() {
        let five = 5
        let plus = + five
        let d = + 2.5
        Console.WriteLine("UnaryPlusExpression: plus=$plus double=$d")
    }
}
