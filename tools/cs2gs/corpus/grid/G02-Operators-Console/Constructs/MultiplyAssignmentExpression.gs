// inventory: MultiplyAssignmentExpression

package Corpus.Grid02

import System

shared class MultiplyAssignmentExpressionFixture {
    func Run() {
        var n = 6
        n *= 7
        var d = 1.5
        d *= 4.0
        Console.WriteLine("MultiplyAssignmentExpression: int=$n double=$d")
    }
}
