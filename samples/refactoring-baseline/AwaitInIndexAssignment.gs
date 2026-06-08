// file: AwaitInIndexAssignment.gs
// Wave-1 P0-4: await inside an array-index assignment position. Pins the
// SpillSequenceSpiller switch arm for BoundIndexAssignmentExpression.

package GSharp.Refactoring.AwaitInIndexAssignment

import System
import System.Threading.Tasks

async func one() int32 {
    await Task.Delay(0)
    return 9
}

async func run() int32 {
    var arr = []int32{0, 0, 0}
    arr[1] = await one()
    return arr[1]
}

Console.WriteLine(run().Result)
