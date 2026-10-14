// inventory: RefExpression — issue #1900: ref locals aliasing an array
// element and a plain local: 'ref int r = ref xs[1]', 'ref int alias = ref v'.
// Maps to G#'s native ref-aliasing local (`let/var ref name T = lvalue`,
// issue #491/ADR-0060) so writes through the alias observably hit the
// original storage. RefExpressionLocalFunction.cs covers the supported static
// ref-returning-local-function/re-alias shape.

package Corpus.Grid09

import System

shared class RefExpressionFixture {
    func Run() {
        let xs[]int32 = []int32{1, 2, 3}
        // Ref local aliasing an array element.
        var ref r int32 = xs[1]
        r = 20
        Console.WriteLine("RefExpression: xs=${string.Join(",", xs)}")
        var v = 5
        var ref alias int32 = v
        alias = 6
        Console.WriteLine("RefExpression: v=$v")
    }
}
