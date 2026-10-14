// inventory: UnsignedRightShiftAssignmentExpression

package Corpus.Grid02

import System

shared class UnsignedRightShiftAssignmentExpressionFixture {
    func Run() {
        var v = 48
        v >>>= 3
        var w = -32
        w >>>= 2
        Console.WriteLine("UnsignedRightShiftAssignmentExpression: v=$v w=$w")
    }
}
