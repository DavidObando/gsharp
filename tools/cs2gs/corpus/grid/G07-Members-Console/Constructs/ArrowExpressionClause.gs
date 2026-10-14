// inventory: ArrowExpressionClause — expression-bodied method, property, and constructor

package Corpus.Grid07

import System

open class ArrowBox {
    private let _value int32

    init(value int32) {
        _value = value
    }

    prop Value int32 -> _value

    func Doubled() int32 -> _value * 2

    shared {
        func TripleOf(input int32) int32 -> input * 3
    }
}

shared class ArrowExpressionClauseFixture {
    func Run() {
        let box = ArrowBox(21)
        Console.WriteLine("ArrowExpressionClause: value=" + box.Value.ToString())
        Console.WriteLine("ArrowExpressionClause: doubled=" + box.Doubled().ToString())
        Console.WriteLine("ArrowExpressionClause: tripled=" + ArrowBox.TripleOf(box.Value).ToString())
    }
}
