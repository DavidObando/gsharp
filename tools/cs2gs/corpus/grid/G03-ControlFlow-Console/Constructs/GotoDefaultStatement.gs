// inventory: GotoDefaultStatement

package Corpus.Grid03.Constructs

import System
import System.Collections.Generic

shared class GotoDefaultStatementFixture {
    func Run() {
        // `goto default;` jumps to the default section's statement list
        // without re-evaluating the switch subject.
        let trace = List[string]()
        let value = 7
        switch value {
            case 7 {
                trace.Add("case7")
                fallthrough
            }
            default {
                trace.Add("default")
            }
        }
        Console.WriteLine("GotoDefaultStatement: trace = ${string.Join(",", trace)}")
    }
}
