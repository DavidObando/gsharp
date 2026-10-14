// inventory: ConditionalAccessExpression

package Corpus.Grid02

import System

shared class ConditionalAccessExpressionFixture {
    func Run() {
        let word string? = "hello"
        let nothing string? = nil
        let len = word?.Length ?? -1
        let nullLen = nothing?.Length ?? -1
        Console.WriteLine("ConditionalAccessExpression: len=$len nullLen=$nullLen")
    }
}
