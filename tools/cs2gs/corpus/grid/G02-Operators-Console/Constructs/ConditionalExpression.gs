// inventory: ConditionalExpression

package Corpus.Grid02

import System

shared class ConditionalExpressionFixture {
    func Run() {
        let a = 6
        let b = 9
        let max = if a > b {
            a
        } else {
            b
        }
        let label = if a % 2 == 0 {
            "even"
        } else {
            "odd"
        }
        let clamped = if a < 0 {
            0
        } else {
            (
                if a > 5 {
                    5
                } else {
                    a
                }
            )
        }
        Console.WriteLine("ConditionalExpression: max=$max label=$label clamped=$clamped")
    }
}
