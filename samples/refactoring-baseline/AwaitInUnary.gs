// file: AwaitInUnary.gs
// Wave-1 P0-4: await inside a unary-operator position. Pins the
// SpillSequenceSpiller switch arm for BoundUnaryExpression.

package GSharp.Refactoring.AwaitInUnary

import System
import System.Threading.Tasks

async func one() int32 {
    await Task.Delay(0)
    return 4
}

async func run() int32 {
    let n = -await one()
    return n
}

Console.WriteLine(run().Result)
