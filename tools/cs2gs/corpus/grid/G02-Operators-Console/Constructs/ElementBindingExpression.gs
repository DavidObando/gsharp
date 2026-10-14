// inventory: ElementBindingExpression

package Corpus.Grid02

import System

shared class ElementBindingExpressionFixture {
    func Run() {
        let numbers[]?int32 = []int32{10, 20, 30}
        let empty[]?int32 = nil
        let first = numbers?[0] ?? -1
        let missing = empty?[0] ?? -1
        Console.WriteLine("ElementBindingExpression: first=$first missing=$missing")
    }
}
