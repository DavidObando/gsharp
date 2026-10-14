// inventory: LeftShiftAssignmentExpression

package Corpus.Grid02

import System

shared class LeftShiftAssignmentExpressionFixture {
    func Run() {
        var v = 3
        v <<= 4
        Console.WriteLine("LeftShiftAssignmentExpression: v=$v")
    }
}
