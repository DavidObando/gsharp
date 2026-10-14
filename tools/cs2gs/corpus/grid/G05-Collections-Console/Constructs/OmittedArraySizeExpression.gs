// inventory: OmittedArraySizeExpression

package Corpus.Grid05

import System

shared class OmittedArraySizeExpressionFixture {
    func Run() {
        let xs = []int32{1, 2, 3}
        Console.WriteLine("OmittedArraySizeExpression: xs=${string.Join(",", xs)}")
        let ys = []string{"solo"}
        Console.WriteLine("OmittedArraySizeExpression: ys=${ys[0]} len=${ys.Length}")
    }
}
