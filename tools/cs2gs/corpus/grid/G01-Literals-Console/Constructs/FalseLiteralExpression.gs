// inventory: FalseLiteralExpression

package Corpus.Grid01

import System

shared class FalseLiteralExpressionFixture {
    func Run() {
        let disabled = false
        if !disabled {
            Console.WriteLine("FalseLiteralExpression: branch taken")
        }
        Console.WriteLine("FalseLiteralExpression: value=${false} local=$disabled")
    }
}
