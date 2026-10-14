// inventory: SimpleAssignmentExpression

package Corpus.Grid02

import System

shared class SimpleAssignmentExpressionFixture {
    func Run() {
        var a = 1
        a = 2
        var b int32
        b = a
        var c = 0
        c = (b = 7)
        Console.WriteLine("SimpleAssignmentExpression: a=$a b=$b c=$c")
    }
}
