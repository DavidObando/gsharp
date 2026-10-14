// inventory: LogicalOrExpression

package Corpus.Grid02

import System

shared class LogicalOrExpressionFixture {
    func Run() {
        let s string? = nil
        let safe = s == nil || s.Length > 0
        let either = 1 > 2 || 2 > 1
        Console.WriteLine("LogicalOrExpression: safe=$safe either=$either")
    }
}
