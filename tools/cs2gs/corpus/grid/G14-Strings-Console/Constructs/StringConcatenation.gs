// inventory: AddExpression

package Corpus.Grid14

import System

shared class StringConcatenationFixture {
    func Run() {
        let first = "con"
        let s = first + "cat" + "enation"
        let n = 42
        let c = 'x'
        let b = true
        let mixed = "n=" + n.ToString() + " c=" + c + " b=" + b.ToString()
        // Issue #1883: concatenating a non-string LITERAL operand lowers
        // to an explicit `.ToString()` call; the literal receiver
        // (`42.ToString()`) must be parenthesized (`(42).ToString()`) or
        // G#'s lexer/parser rejects it (ADR-0054, GS0005/GS0157).
        let literalConcat = "n=" + (42).ToString()
        let literalToString = (42).ToString()
        var built = ""
        for var i = 1; i <= 3; i++ {
            built += i.ToString() + ";"
        }
        Console.WriteLine("StringConcatenation: s=$s")
        Console.WriteLine("StringConcatenation: mixed=$mixed")
        Console.WriteLine("StringConcatenation: literalConcat=$literalConcat")
        Console.WriteLine("StringConcatenation: literalToString=$literalToString")
        Console.WriteLine("StringConcatenation: built=$built")
    }
}
