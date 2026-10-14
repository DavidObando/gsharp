// inventory: SubtractAssignmentExpression

package Corpus.Grid02

import System

shared class SubtractAssignmentExpressionFixture {
    func Run() {
        var n = 10
        n -= 4
        var d = 5.5
        d -= 1.25
        Console.WriteLine("SubtractAssignmentExpression: int=$n double=$d")
    }
}
