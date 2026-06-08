// file: ReturnInTryFinally.gs
// Wave-1 P0-2: return inside try/finally must use leave/endfinally lowering
// so the JIT accepts the protected region.

package GSharp.Refactoring.ReturnInTryFinally

import System

var trace = ""

func compute() int32 {
    try {
        trace = trace + "t"
        return 42
    } finally {
        trace = trace + "f"
    }
}

Console.WriteLine(compute())
Console.WriteLine(trace)
