// inventory: RightShiftAssignmentExpression

package Corpus.Grid02

import System

shared class RightShiftAssignmentExpressionFixture {
    func Run() {
        var v = 48
        v >>= 3
        var w = -32
        w >>= 2
        Console.WriteLine("RightShiftAssignmentExpression: v=$v w=$w")
    }
}
