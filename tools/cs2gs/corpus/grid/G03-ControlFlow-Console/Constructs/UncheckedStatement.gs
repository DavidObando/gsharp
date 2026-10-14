// inventory: UncheckedStatement

package Corpus.Grid03.Constructs

import System

shared class UncheckedStatementFixture {
    func Run() {
        unchecked {
            let big = 2147483647
            let one = 1
            let wrapped = big + one
            Console.WriteLine("UncheckedStatement: max int plus one wraps to $wrapped")
        }
        unchecked {
            let a = 2000000000
            let b = 2000000000
            let sum = a + b
            Console.WriteLine("UncheckedStatement: 2000000000 + 2000000000 wraps to $sum")
        }
    }
}
