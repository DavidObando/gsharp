// inventory: YieldReturnStatement

package Corpus.Grid03.Constructs

import System
import System.Collections.Generic

shared class YieldReturnStatementFixture {
    func Run() {
        var sum = 0
        for f in Fibonacci(8) {
            sum += f
            Console.WriteLine("YieldReturnStatement: fib $f")
        }
        Console.WriteLine("YieldReturnStatement: sum of first 8 fibs = $sum")
    }

    private func Fibonacci(count int32) sequence[int32] {
        var a = 0
        var b = 1
        for var i = 0; i < count; i++ {
            yield a
            let next = a + b
            a = b
            b = next
        }
    }
}
