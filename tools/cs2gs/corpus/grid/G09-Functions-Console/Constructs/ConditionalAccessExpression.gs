// inventory: ConditionalAccessExpression

package Corpus.Grid09

import System

shared class ConditionalAccessExpressionFixture {
    func Run() {
        var handler((string) -> void)? = nil
        handler?("never-printed")
        Console.WriteLine("ConditionalAccessExpression: nullHandler=${(if handler == nil { "null" } else { "set" })}")
        // Note: plain concatenation (not interpolation) inside the lambda —
        // the gsc emitter cannot yet emit InterpolatedStringExpression
        // inside lambda bodies (GS9998).
        handler = (s string) -> Console.WriteLine("ConditionalAccessExpression: got " + s)
        handler?("ping")
        var square((int32) -> int32)? = nil
        let missed = square?(3)
        Console.WriteLine(
            "ConditionalAccessExpression: missed=${(if (missed != nil) { missed.ToString() } else { "none" })}"
        )
        square = (x int32) -> x * x
        let hit = square?(3)
        Console.WriteLine("ConditionalAccessExpression: hit=${(if (hit != nil) { hit.ToString() } else { "none" })}")
    }
}
