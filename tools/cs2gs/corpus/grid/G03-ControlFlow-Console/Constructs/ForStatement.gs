// inventory: ForStatement

package Corpus.Grid03.Constructs

import System

shared class ForStatementFixture {
    func Run() {
        var total = 0
        {
            var i = 0
            var j = 10
            while i < j {
                total += j - i
                i++
                j--
            }
        }
        Console.WriteLine("ForStatement: converging loop total = $total")
        var hits = 0
        for var i = 0; i < 10; i++ {
            if i % 4 == 1 {
                continue
            }
            hits++
        }
        Console.WriteLine("ForStatement: hits with continue skipping i%4==1 = $hits")
        var countdown = 0
        for var i = 5; i > 0; i-- {
            countdown = countdown * 10 + i
        }
        Console.WriteLine("ForStatement: countdown digits = $countdown")
    }
}
