// inventory: EqualsExpression

package Corpus.Grid02

import System

shared class EqualsExpressionFixture {
    func Run() {
        let a = 5
        let b = 5
        let s = "hi"
        let t string? = nil
        let sameInt = a == b
        let sameString = s == "hi"
        let isNull = t == nil
        // ADR-0171 / issue #3501: tuple equality — element-wise, names ignored.
        let pos(Line int32, Column int32) = (3, 5)
        let sameTuple = pos == (3, 5)
        let nestedTuple = ((1, 2), "x") == ((1, 2), "x")
        Console.WriteLine(
            "EqualsExpression: ints=$sameInt strings=$sameString nullCheck=$isNull tuples=$sameTuple nested=$nestedTuple"
        )
    }
}
