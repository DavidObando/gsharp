// inventory: DivideAssignmentExpression

package Corpus.Grid02

import System

shared class DivideAssignmentExpressionFixture {
    func Run() {
        var n = 29
        n /= 4
        var d = 9.0
        d /= 4.0
        Console.WriteLine("DivideAssignmentExpression: int=$n double=$d")
    }
}
