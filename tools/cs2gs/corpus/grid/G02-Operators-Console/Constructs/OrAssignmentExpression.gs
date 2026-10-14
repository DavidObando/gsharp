// inventory: OrAssignmentExpression

package Corpus.Grid02

import System

shared class OrAssignmentExpressionFixture {
    func Run() {
        var bits = 0b0101
        bits |= 0b0010
        var flag = false
        flag |= true
        Console.WriteLine("OrAssignmentExpression: bits=$bits flag=$flag")
    }
}
