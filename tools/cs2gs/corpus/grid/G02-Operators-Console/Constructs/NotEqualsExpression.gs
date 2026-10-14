// inventory: NotEqualsExpression

package Corpus.Grid02

import System

shared class NotEqualsExpressionFixture {
    func Run() {
        let a = 3
        let b = 4
        let s = "a"
        let t string? = nil
        let diffInt = a != b
        let diffString = s != "a"
        let notNull = t != nil
        // ADR-0171 / issue #3501: the self-migration wall shape — a fresh
        // tuple literal `!=` a named-element tuple value.
        let expected(Line int32, Column int32) = (3, 5)
        let diffTuple = (a, b) != expected
        Console.WriteLine("NotEqualsExpression: ints=$diffInt strings=$diffString notNull=$notNull tuples=$diffTuple")
    }
}
