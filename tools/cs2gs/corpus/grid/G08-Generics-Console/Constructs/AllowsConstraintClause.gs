// inventory: AllowsConstraintClause — `where T : allows ref struct` anti-constraint incl. RefStructConstraint (C#13 probe)

package Corpus.Grid08

import System

shared class SpanFriendly {
    func Describe[T](value T) string {
        return "held"
    }
}

shared class AllowsConstraintClauseFixture {
    func Run() {
        Console.WriteLine("AllowsConstraintClause: int=" + SpanFriendly.Describe(42))
        Console.WriteLine("AllowsConstraintClause: string=" + SpanFriendly.Describe("text"))
    }
}
