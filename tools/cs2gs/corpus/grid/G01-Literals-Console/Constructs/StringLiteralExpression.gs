// inventory: StringLiteralExpression

package Corpus.Grid01

import System

shared class StringLiteralExpressionFixture {
    func Run() {
        let plain = "hello world"
        let escaped = "line1\tcolumn2"
        let verbatim = "C:\\temp\\logs"
        let verbatimQuotes = "say \"hi\" twice"
        let raw = "He said \"raw\" strings work."
        let empty = ""
        Console.WriteLine("StringLiteralExpression: plain=$plain")
        Console.WriteLine("StringLiteralExpression: escaped=$escaped")
        Console.WriteLine("StringLiteralExpression: verbatim=$verbatim")
        Console.WriteLine("StringLiteralExpression: verbatimQuotes=$verbatimQuotes")
        Console.WriteLine("StringLiteralExpression: raw=$raw")
        Console.WriteLine("StringLiteralExpression: emptyLength=${empty.Length}")
    }
}
