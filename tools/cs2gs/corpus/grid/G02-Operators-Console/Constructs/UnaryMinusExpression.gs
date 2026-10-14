// inventory: UnaryMinusExpression

package Corpus.Grid02

import System

shared class UnaryMinusExpressionFixture {
    func Run() {
        let five = 5
        let negated = -five
        let d = -2.5
        let expr = -(3 + 4)
        Console.WriteLine("UnaryMinusExpression: negated=$negated double=$d expr=$expr")
    }
}
