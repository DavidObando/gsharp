// file: AsyncAwaitInNestedLoop.gs
// Regression for issue #292 (nested-loop shape): an `await` in the inner loop
// body, with an additional `await` in the outer loop body, must iterate both
// loops the correct number of times. Exercises multiple distinct resume states
// whose resume labels sit inside two levels of flattened loop back-edges.

package GSharp.Samples.AsyncAwaitInNestedLoop

import System
import System.Threading.Tasks

async func loopy() {
    var i = 0
    for i < 2 {
        await Task.Delay(1)
        var j = 0
        for j < 2 {
            await Task.Delay(1)
            Console.WriteLine("i=$i j=$j")
            j = j + 1
        }
        i = i + 1
    }
}

loopy().Wait()
Console.WriteLine("done")
