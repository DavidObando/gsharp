// inventory: DoStatement

package Corpus.Grid03.Constructs

import System

shared class DoStatementFixture {
    func Run() {
        var n = 1
        var steps = 0
        do {
            n = n * 2
            steps++
        } while n < 100
        Console.WriteLine("DoStatement: doubled to $n in $steps steps")
        var k = 10
        do {
            Console.WriteLine("DoStatement: body runs at least once, k = $k")
            k++
        } while k < 5
        Console.WriteLine("DoStatement: after loop k = $k")
    }
}
