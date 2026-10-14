// inventory: ModuloAssignmentExpression

package Corpus.Grid02

import System

shared class ModuloAssignmentExpressionFixture {
    func Run() {
        var n = 29
        n %= 4
        var d = 7.5
        d %= 2.0
        Console.WriteLine("ModuloAssignmentExpression: int=$n double=$d")
    }
}
