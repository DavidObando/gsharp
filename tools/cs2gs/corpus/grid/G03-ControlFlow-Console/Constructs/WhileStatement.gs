// inventory: WhileStatement

package Corpus.Grid03.Constructs

import System

shared class WhileStatementFixture {
    func Run() {
        var n = 6
        var steps = 0
        while n != 1 {
            if n % 2 == 0 {
                n = n / 2
            } else {
                n = (3 * n) + 1
            }
            steps++
        }
        Console.WriteLine("WhileStatement: collatz(6) reached 1 in $steps steps")
        var never = 0
        while never > 0 {
            never--
        }
        Console.WriteLine("WhileStatement: false-condition body never ran, never = $never")
    }
}
