// inventory: StringLiteralExpression

package Corpus.Grid14

import System

shared class EscapeSequencesFixture {
    func Run() {
        let quote = "she said \"hi\""
        let path = "C:\\temp"
        let uni = "ABC"
        let newlineOnly = "\n"
        let nulOnly = "\u0000"
        Console.WriteLine("EscapeSequences: quote=$quote")
        Console.WriteLine("EscapeSequences: path=$path")
        Console.WriteLine("EscapeSequences: uni=$uni")
        Console.WriteLine("EscapeSequences: newlineCode=${int32(newlineOnly[0])} nulCode=${int32(nulOnly[0])}")
    }
}
