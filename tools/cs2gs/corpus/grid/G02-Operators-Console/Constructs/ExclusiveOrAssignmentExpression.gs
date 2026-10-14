// inventory: ExclusiveOrAssignmentExpression

package Corpus.Grid02

import System

shared class ExclusiveOrAssignmentExpressionFixture {
    func Run() {
        var bits = 0b1100
        bits ^= 0b1010
        var flag = true
        flag ^= true
        Console.WriteLine("ExclusiveOrAssignmentExpression: bits=$bits flag=$flag")
    }
}
