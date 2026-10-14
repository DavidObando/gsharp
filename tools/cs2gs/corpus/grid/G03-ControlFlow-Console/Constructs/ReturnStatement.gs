// inventory: ReturnStatement

package Corpus.Grid03.Constructs

import System

shared class ReturnStatementFixture {
    func Run() {
        Console.WriteLine("ReturnStatement: Classify(-4) = ${Classify(-4)}")
        Console.WriteLine("ReturnStatement: Classify(0) = ${Classify(0)}")
        Console.WriteLine("ReturnStatement: Classify(9) = ${Classify(9)}")
        PrintIfEven(3)
        PrintIfEven(8)
    }

    private func Classify(n int32) string {
        if n < 0 {
            return "negative"
        }
        if n == 0 {
            return "zero"
        }
        return "positive"
    }

    private func PrintIfEven(n int32) {
        if n % 2 != 0 {
            return
        }
        Console.WriteLine("ReturnStatement: $n is even (void early return skipped odd)")
    }
}
