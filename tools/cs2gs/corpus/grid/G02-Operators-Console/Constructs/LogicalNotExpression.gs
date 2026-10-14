// inventory: LogicalNotExpression

package Corpus.Grid02

import System

shared class LogicalNotExpressionFixture {
    func Run() {
        let on = true
        let off = !on
        let doubled = ! !on
        Console.WriteLine("LogicalNotExpression: off=$off doubled=$doubled")
    }
}
