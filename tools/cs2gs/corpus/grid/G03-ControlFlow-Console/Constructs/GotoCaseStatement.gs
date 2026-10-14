// inventory: GotoCaseStatement

package Corpus.Grid03.Constructs

import System
import System.Collections.Generic

shared class GotoCaseStatementFixture {
    func Run() {
        // `goto case 2;` jumps to case 2's statement list without
        // re-evaluating the switch subject; the trace below proves
        // fall-through and side-effect order are preserved.
        let trace = List[string]()
        let value = 1
        switch value {
            case 1 {
                trace.Add("case1")
                fallthrough
            }
            case 2 {
                trace.Add("case2")
            }
            default {
                trace.Add("default")
            }
        }
        Console.WriteLine("GotoCaseStatement: trace = ${string.Join(",", trace)}")
    }
}
