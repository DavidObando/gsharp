// inventory: AsExpression

package Corpus.Grid02

import System

shared class AsExpressionFixture {
    func Run() {
        let boxedText object = "hello"
        let boxedNumber object = 42
        let text string? = boxedText as string
        let missing string? = boxedNumber as string
        Console.WriteLine("AsExpression: text=${text ?? "null"} missing=${missing ?? "null"}")
    }
}
