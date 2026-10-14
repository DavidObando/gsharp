// inventory: InterpolatedStringExpression

package Corpus.Grid14

import System

shared class InterpolatedStringExpressionFixture {
    func Run() {
        let name = "Ada"
        let year = 1843
        Console.WriteLine("InterpolatedStringExpression: basic=$name wrote notes in $year")
        Console.WriteLine("InterpolatedStringExpression: verbatim=C:\\data\\$name")
        Console.WriteLine("InterpolatedStringExpression: raw=\"$name\" quoted")
    }
}
