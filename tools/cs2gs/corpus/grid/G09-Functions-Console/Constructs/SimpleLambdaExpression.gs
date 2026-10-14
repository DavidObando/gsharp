// inventory: SimpleLambdaExpression

package Corpus.Grid09

import System
import System.Linq

shared class SimpleLambdaExpressionFixture {
    func Run() {
        let twice(int32) -> int32 = (x int32) -> x * 2
        Console.WriteLine("SimpleLambdaExpression: twice=${twice(8)}")
        // Closure over a local.
        let factor = 10
        let scale(int32) -> int32 = (x int32) -> x * factor
        Console.WriteLine("SimpleLambdaExpression: scale=${scale(4)}")
        let bang(string) -> string = (s string) -> s + "!"
        Console.WriteLine("SimpleLambdaExpression: bang=${bang("go")}")
        let bumped = []int32{1, 2, 3}.Select((x int32) -> x + 1)
        Console.WriteLine("SimpleLambdaExpression: bumped=${string.Join(",", bumped)}")
    }
}
