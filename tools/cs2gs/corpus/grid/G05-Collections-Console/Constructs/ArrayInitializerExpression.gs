// inventory: ArrayInitializerExpression

package Corpus.Grid05

import System

shared class ArrayInitializerExpressionFixture {
    func Run() {
        let xs[]int32 = []int32{1, 2, 3}
        Console.WriteLine("ArrayInitializerExpression: xs=${string.Join(",", xs)}")
        let names[]string = []string{"north", "south"}
        Console.WriteLine("ArrayInitializerExpression: names=${string.Join(",", names)}")
        let single[]int32 = []int32{42}
        Console.WriteLine("ArrayInitializerExpression: single=${single[0]} len=${single.Length}")
    }
}
