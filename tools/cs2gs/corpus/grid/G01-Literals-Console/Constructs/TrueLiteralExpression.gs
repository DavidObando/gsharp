// inventory: TrueLiteralExpression

package Corpus.Grid01

import System

shared class TrueLiteralExpressionFixture {
    func Run() {
        let enabled = true
        if enabled {
            Console.WriteLine("TrueLiteralExpression: branch taken")
        }
        Console.WriteLine("TrueLiteralExpression: value=${true} local=$enabled")
    }
}
