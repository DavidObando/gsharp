// inventory: LabeledStatement

package Corpus.Grid03.Constructs

import System

shared class LabeledStatementFixture {
    func Run() {
        // A label on a non-loop statement (ADR-0070 generalized by
        // ADR-0139) is a valid goto target; here it also just labels an
        // ordinary statement with nothing jumping to it, exercising the
        // labeled-statement form on its own.
        var total = 0
        addOne:
        total += 1
        if total < 3 {
            goto addOne
        }
        Console.WriteLine("LabeledStatement: total = $total")
    }
}
