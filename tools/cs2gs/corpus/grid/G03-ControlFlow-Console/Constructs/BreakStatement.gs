// inventory: BreakStatement

package Corpus.Grid03.Constructs

import System

shared class BreakStatementFixture {
    func Run() {
        var firstMultipleOfSeven = -1
        for var i = 30; i < 60; i++ {
            if i % 7 == 0 {
                firstMultipleOfSeven = i
                break
            }
        }
        Console.WriteLine("BreakStatement: first multiple of 7 in [30,60) = $firstMultipleOfSeven")
        var n = 0
        while true {
            n++
            if n == 5 {
                break
            }
        }
        Console.WriteLine("BreakStatement: while-true exited at n = $n")
    }
}
