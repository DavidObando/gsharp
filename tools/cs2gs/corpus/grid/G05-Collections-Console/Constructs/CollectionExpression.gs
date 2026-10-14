// inventory: CollectionExpression

package Corpus.Grid05

import System
import System.Collections.Generic

shared class CollectionExpressionFixture {
    func Run() {
        let a[]int32 = []int32{1, 2, 3}
        Console.WriteLine("CollectionExpression: array=${string.Join(",", a)}")
        let ss[]string = []string{"x", "y", "z"}
        Console.WriteLine("CollectionExpression: strings=${string.Join(",", ss)}")
        let empty[]int32 = System.Array.Empty[int32]()
        Console.WriteLine("CollectionExpression: emptyLen=${empty.Length}")
        // List<T>-targeted collection expression (issue #1897): lowers to
        // the G# collection-initializer form (List[int32]{...}), not an
        // array literal (which does not convert to List[int32]).
        let list List[int32] = List[int32]{10, 20}
        Console.WriteLine("CollectionExpression: list=${string.Join(",", list)} count=${list.Count}")
        // SpreadElement (issues #1897/#3096): maps to native G#
        // ellipsis-spread syntax inside the array literal.
        let rest[]int32 = []int32{2, 3}
        let spread[]int32 = []int32{1, ...rest, 9}
        Console.WriteLine("CollectionExpression: spread=${string.Join(",", spread)}")
    }
}
