// file: AsyncValueReturns.gs
//
// Regression coverage for issue #290: `async func`s whose kickoff returns a
// VALUE type (so the synthesized return is `Task<T>` for a value `T`) must
// build and run. The bug surfaced only on the SDK build path, where reference
// assemblies are loaded through a MetadataLoadContext and `Task<T>` had to be
// constructed with a type argument projected into that same context. This
// sample exercises int32, bool, and float64 async returns end-to-end.

package GSharp.Samples.AsyncValueReturns

import System
import System.Threading.Tasks

async func asyncInt() int32 {
    await Task.Delay(1)
    return 21 * 2
}

async func asyncBool() bool {
    await Task.Delay(1)
    return true
}

async func asyncFloat() float64 {
    await Task.Delay(1)
    return 3.5 + 1.0
}

async func driver() int32 {
    let i = await asyncInt()
    let b = await asyncBool()
    let f = await asyncFloat()
    Console.WriteLine("i = $i")
    Console.WriteLine("b = $b")
    Console.WriteLine("f = $f")
    return i
}

scope {
    go driver()
}

Console.WriteLine("done")
