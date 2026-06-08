// file: YieldInTryFinally.gs
// Wave-1 P0-3: yield inside try/finally needs the iterator-side dispatch
// (TryDispatchPlanner) so MoveNext runs the finally on Dispose.

package GSharp.Refactoring.YieldInTryFinally

import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
    } finally {
        Console.WriteLine("dispose")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
