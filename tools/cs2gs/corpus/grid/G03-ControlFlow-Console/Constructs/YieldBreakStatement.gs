// inventory: YieldBreakStatement

package Corpus.Grid03.Constructs

import System
import System.Collections.Generic

shared class YieldBreakStatementFixture {
    func Run() {
        let values[]int32 = []int32{4, 8, 15, -1, 16, 23}
        for v in TakeUntilNegative(values) {
            Console.WriteLine("YieldBreakStatement: yielded $v")
        }
        Console.WriteLine("YieldBreakStatement: iteration stopped at first negative")
    }

    private func TakeUntilNegative(values[]int32) sequence[int32] {
        for v in values {
            if v < 0 {
                yield break
            }
            yield v
        }
    }
}
