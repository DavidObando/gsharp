// inventory: GotoStatement

package Corpus.Grid03.Constructs

import System

shared class GotoStatementFixture {
    func Run() {
        var count = 0
        retry:
        count++
        if count < 3 {
            goto retry
        }
        Console.WriteLine("GotoStatement: backward loop finished at count = $count")
        var step = 0
        goto skip
        step = 100
        skip:
        step += 1
        Console.WriteLine("GotoStatement: forward jump left step = $step")
    }
}
