// inventory: AddAssignmentExpression

package Corpus.Grid02

import System

shared class AddAssignmentExpressionFixture {
    func Run() {
        var n = 10
        n += 5
        var d = 1.5
        d += 2.25
        var s = "ab"
        s += "cd"
        Console.WriteLine("AddAssignmentExpression: int=$n double=$d string=$s")
    }
}
