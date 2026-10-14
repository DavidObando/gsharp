// inventory: TryStatement — await inside loop bodies and try/catch/finally
// Awaits inside for/while loops and inside try, catch, and finally blocks. The
// thrown exception is created and caught locally, so control flow is fixed.

package Corpus.Grid10.Constructs

import System
import System.Threading.Tasks

shared class TryStatementFixture {
    async func RunAsync() {
        var total = 0
        for var i = 1; i <= 3; i++ {
            total += await Task.FromResult(i * 10)
            Console.WriteLine("TryStatement: loop step $i total=$total")
        }
        var iterations = 0
        while iterations < 2 {
            iterations += await Task.FromResult(1)
        }
        Console.WriteLine("TryStatement: while iterations=$iterations")
        try {
            let inTry = await Task.FromResult(5)
            Console.WriteLine("TryStatement: try value=$inTry")
            throw InvalidOperationException("expected")
        } catch (ex InvalidOperationException) {
            let inCatch = await Task.FromResult(ex.Message.Length)
            Console.WriteLine("TryStatement: catch messageLength=$inCatch")
        } finally {
            let inFinally = await Task.FromResult(99)
            Console.WriteLine("TryStatement: finally value=$inFinally")
        }
    }
}
