// inventory: LogicalAndExpression

package Corpus.Grid02

import System

shared class LogicalAndExpressionFixture {
    func Run() {
        let s string? = nil
        let guarded = s != nil && s.Length > 0
        let both = 2 < 3 && 3 < 4
        Console.WriteLine("LogicalAndExpression: guarded=$guarded both=$both")
    }
}
