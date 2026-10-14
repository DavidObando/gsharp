// inventory: CoalesceExpression

package Corpus.Grid02

import System

shared class CoalesceExpressionFixture {
    func Run() {
        let missing string? = nil
        let present string? = "value"
        let first = missing ?? present ?? "last"
        let none int32? = nil
        let picked = none ?? 21
        Console.WriteLine("CoalesceExpression: first=$first picked=$picked")
    }
}
