// inventory: IfStatement

package Corpus.Grid03.Constructs

import System

shared class IfStatementFixture {
    func Run() {
        for var score = 55; score <= 95; score += 10 {
            var grade string
            if score >= 90 {
                grade = "A"
            } else if score >= 80 {
                grade = "B"
            } else if score >= 70 {
                grade = "C"
            } else {
                grade = "F"
            }
            Console.WriteLine("IfStatement: score $score -> grade $grade")
        }
        let n = 12
        if n % 2 == 0 {
            Console.WriteLine("IfStatement: $n is even (if without else)")
        }
        if n > 10 {
            if n < 20 {
                Console.WriteLine("IfStatement: $n is between 10 and 20 (nested if)")
            }
        }
    }
}
