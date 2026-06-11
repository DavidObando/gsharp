// file: AwaitInFieldAssignment.gs
// Wave-1 P0-4: await inside a duplicating assignment position (field assign).
// Pins the SpillSequenceSpiller switch arm for BoundFieldAssignmentExpression.

package GSharp.Refactoring.AwaitInFieldAssignment

import System
import System.Threading.Tasks

type Holder class {
    var Value int32
}

async func one() int32 {
    await Task.Delay(0)
    return 7
}

async func run() int32 {
    var h = Holder{Value: 0}
    h.Value = await one()
    return h.Value
}

Console.WriteLine(run().Result)
