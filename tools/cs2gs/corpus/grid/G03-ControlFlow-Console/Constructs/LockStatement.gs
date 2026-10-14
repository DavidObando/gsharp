// inventory: LockStatement

package Corpus.Grid03.Constructs

import System
import SystemObject = System.Object

shared class LockStatementFixture {
    private let Gate object = SystemObject()
    private var _counter int32

    func Run() {
        lock Gate {
            _counter++
            Console.WriteLine("LockStatement: counter=$_counter")
        }
        try {
            lock Gate {
                Console.WriteLine("LockStatement: about to throw")
                throw InvalidOperationException("boom")
            }
        } catch (ex InvalidOperationException) {
            Console.WriteLine("LockStatement: caught ${ex.Message}")
        }
        // The prior lock's body threw, but `finally` must still release
        // the monitor — re-acquiring the SAME gate here with no deadlock
        // is the deterministic proof (issue #1885).
        lock Gate {
            _counter++
            Console.WriteLine("LockStatement: counter=$_counter")
        }
    }
}
