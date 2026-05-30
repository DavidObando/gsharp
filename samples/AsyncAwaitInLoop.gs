// file: AsyncAwaitInLoop.gs
// Regression for issue #292: `await` inside a loop body must iterate the loop
// the correct number of times. Previously a single `await` in a `for cond`
// body caused the loop to run only once because the suspension/resume split
// dropped the loop's condition-test back-edge. The async state-machine
// lowering runs over the already-flattened (goto/label) loop form, so the
// resume label sits between the body and the back-edge and every iteration
// re-tests the condition. `Task.Delay` forces a real suspension on each pass.

package GSharp.Samples.AsyncAwaitInLoop

import System
import System.Threading.Tasks

async func loopy() {
    var n = 0
    for n < 3 {
        await Task.Delay(1)
        n = n + 1
        Console.WriteLine("tick $n")
    }
}

loopy().Wait()
Console.WriteLine("done")
