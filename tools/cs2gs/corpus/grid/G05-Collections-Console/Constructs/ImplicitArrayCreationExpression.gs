// inventory: ImplicitArrayCreationExpression

package Corpus.Grid05

import System

shared class ImplicitArrayCreationExpressionFixture {
    func Run() {
        let nums = []int32{3, 1, 2}
        Console.WriteLine("ImplicitArrayCreationExpression: nums=${string.Join(",", nums)} len=${nums.Length}")
        let strs = []string{"pico", "nano"}
        Console.WriteLine("ImplicitArrayCreationExpression: strs=${string.Join(",", strs)}")
        let wide = []int64{1L, 2, 3}
        Console.WriteLine("ImplicitArrayCreationExpression: wideSum=${wide[0] + wide[1] + wide[2]}")
    }
}
