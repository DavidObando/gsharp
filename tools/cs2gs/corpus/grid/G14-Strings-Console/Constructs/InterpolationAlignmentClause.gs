// inventory: InterpolationAlignmentClause

package Corpus.Grid14

import System

shared class InterpolationAlignmentClauseFixture {
    func Run() {
        let n = 42
        let s = "hi"
        Console.WriteLine("InterpolationAlignmentClause: [${n,6}] [${s,-6}] [${n,2}]")
        Console.WriteLine("InterpolationAlignmentClause: [${s,8}] [${n,-8}]")
    }
}
