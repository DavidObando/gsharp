// inventory: ArrayCreationExpression

package Corpus.Grid05

import System

shared class ArrayCreationExpressionFixture {
    func Run() {
        let sized = [3]int32
        sized[0] = 10
        sized[1] = 20
        sized[2] = 30
        Console.WriteLine("ArrayCreationExpression: sized=${string.Join(",", sized)}")
        let words = [2]string
        words[0] = "alpha"
        words[1] = "beta"
        Console.WriteLine("ArrayCreationExpression: words=${string.Join(",", words)}")
        let jagged = [2][]int32
        jagged[0] = [2]int32
        jagged[0][0] = 1
        jagged[0][1] = 2
        jagged[1] = [3]int32
        jagged[1][0] = 3
        jagged[1][1] = 4
        jagged[1][2] = 5
        Console.WriteLine(
            "ArrayCreationExpression: jagged0=${string.Join(",", jagged[0])} jagged1=${string.Join(",", jagged[1])}"
        )
        let withInit = []int32{7, 8, 9}
        Console.WriteLine("ArrayCreationExpression: withInit=${string.Join(",", withInit)}")
    }
}
