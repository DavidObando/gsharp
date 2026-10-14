// inventory: CheckedExpression

package Corpus.Grid02

import System

shared class CheckedExpressionFixture {
    func Run() {
        let a = 1000000
        let b = 2000
        let sum = checked(a + b)
        let product = checked(int64(a) * int64(b))
        Console.WriteLine("CheckedExpression: sum=$sum product=$product")
        let max = int32.MaxValue
        let one = 1
        var caught = false
        var wrapped = 0
        try {
            wrapped = checked(max + one)
        } catch (OverflowException) {
            caught = true
        }
        Console.WriteLine("CheckedExpression: overflow caught=$caught wrapped=$wrapped")
        let wide = 300
        var byteCaught = false
        try {
            let narrow = checked(uint8(wide))
            Console.WriteLine("CheckedExpression: narrow=$narrow")
        } catch (OverflowException) {
            byteCaught = true
        }
        Console.WriteLine("CheckedExpression: byte overflow caught=$byteCaught")
    }
}
