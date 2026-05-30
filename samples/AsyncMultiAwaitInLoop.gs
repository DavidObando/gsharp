// file: AsyncMultiAwaitInLoop.gs
// Regression for issue #292 (multi-await shape): two `await`s in a single loop
// iteration previously produced a runtime InvalidProgramException because the
// second suspension point's resume label/back-edge structure was malformed.
// A counted `for` with two awaits per iteration locks in deterministic output.

package GSharp.Samples.AsyncMultiAwaitInLoop

import System
import System.Threading.Tasks

async func loopy() {
    var n = 0
    for n < 2 {
        await Task.Delay(1)
        Console.WriteLine("a $n")
        await Task.Delay(1)
        Console.WriteLine("b $n")
        n = n + 1
    }
}

loopy().Wait()
Console.WriteLine("done")
