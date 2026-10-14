// inventory: CatchFilterClause
// NOTE: a filtered catch with a LATER sibling catch whose type is not provably
// disjoint (e.g. the same exception type) is quarantined: cs2gs reports
// CS2GS-GAP "no faithful G# lowering" (issue #1724). This fixture keeps the
// supported subset: a filtered catch with no overlapping later sibling, where
// a false filter escapes the try (observably identical under rethrow-lowering).

package Corpus.Grid03.Constructs

import System

shared class CatchFilterClauseFixture {
    func Run() {
        for var code = 1; code <= 2; code++ {
            try {
                try {
                    throw InvalidOperationException("code-$code")
                } catch (ex InvalidOperationException) when ex.Message == "code-1" {
                    Console.WriteLine("CatchFilterClause: filter accepted ${ex.Message}")
                }
            } catch (ex InvalidOperationException) {
                Console.WriteLine("CatchFilterClause: filter rejected, outer caught ${ex.Message}")
            }
        }
    }
}
