// inventory: AnonymousObjectCreationExpression

package Corpus.Grid05

import System

shared class AnonymousObjectCreationExpressionFixture {
    func Run() {
        // G# has no anonymous types; `new { ... }` lowers to the same
        // positional tuple literal as a C# named tuple (issue #1934). G#
        // tuples require at least two elements (gsc rejects 1-tuples), so
        // a single-member anonymous object has no valid tuple lowering;
        // only 2+-member anonymous objects are representative fixtures.
        let pair = AnonymousType2_D51B540B4154070E(2, "two")
        Console.WriteLine("AnonymousObjectCreationExpression: pair=${pair.A},${pair.B}")
    }
}

internal data class AnonymousType2_D51B540B4154070E(A int32, B string) { }
