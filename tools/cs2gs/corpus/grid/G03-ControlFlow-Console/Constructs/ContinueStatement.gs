// inventory: ContinueStatement

package Corpus.Grid03.Constructs

import System

shared class ContinueStatementFixture {
    func Run() {
        var sumOfOdds = 0
        for var i = 1; i <= 10; i++ {
            if i % 2 == 0 {
                continue
            }
            sumOfOdds += i
        }
        Console.WriteLine("ContinueStatement: sum of odds 1..10 = $sumOfOdds")
        var w = 0
        var multiplesOfThree = 0
        while w < 9 {
            w++
            if w % 3 != 0 {
                continue
            }
            multiplesOfThree++
        }
        Console.WriteLine("ContinueStatement: multiples of 3 in 1..9 = $multiplesOfThree")
    }
}
