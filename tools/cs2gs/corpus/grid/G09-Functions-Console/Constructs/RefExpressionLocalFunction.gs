package Corpus.Grid09

import System

shared class RefExpressionLocalFunctionFixture {
    func Run() {
        let xs[]int32 = []int32{1, 2, 3}
        let Pick = func (a[]int32, i int32) ref int32 {
            return ref a[i]
        }
        var ref q int32 = Pick(xs, 2)
        q = 30
        Console.WriteLine("RefExpressionLocalFunction: xs=${string.Join(",", xs)}")
    }
}
