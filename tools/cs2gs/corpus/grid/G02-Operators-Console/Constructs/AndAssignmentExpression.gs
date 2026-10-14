// inventory: AndAssignmentExpression

package Corpus.Grid02

import System

shared class AndAssignmentExpressionFixture {
    func Run() {
        var bits = 0b1111
        bits &= 0b1010
        var flag = true
        flag &= false
        Console.WriteLine("AndAssignmentExpression: bits=$bits flag=$flag")
    }
}
