// inventory: StringLiteralExpression

package Corpus.Grid14

import System

shared class EscapeSequenceEscFixture {
    func Run() {
        let esc = "\u001B"
        Console.WriteLine("EscapeSequenceEsc: len=${esc.Length} code=${int32(esc[0])}")
    }
}
