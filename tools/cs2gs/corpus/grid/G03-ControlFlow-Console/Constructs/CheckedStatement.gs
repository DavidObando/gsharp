// inventory: CheckedStatement

package Corpus.Grid03.Constructs

import System

shared class CheckedStatementFixture {
    func Run() {
        checked {
            let a = 1000000
            let b = 2000
            let product = int64(a) * int64(b)
            Console.WriteLine("CheckedStatement: checked product = $product")
        }
        checked {
            let x = 41
            let y = x + 1
            Console.WriteLine("CheckedStatement: checked sum without overflow = $y")
        }
        // issue #1881: the overflow-in-try/catch(OverflowException) case —
        // previously quarantined because cs2gs erased the checked context,
        // silently wrapping instead of throwing.
        var caught = false
        var wrapped = 0
        try {
            let max = int32.MaxValue
            let one = 1
            checked {
                wrapped = max + one
            }
        } catch (OverflowException) {
            caught = true
        }
        Console.WriteLine("CheckedStatement: overflow caught = $caught")
        Console.WriteLine("CheckedStatement: unexpected wrap = $wrapped")
    }
}
