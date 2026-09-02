// file: AsyncGoScopeJoin.gs
//
// Regression for #291: a `scope { go asyncFunc() }` must run the spawned async
// task to completion (structured join) before the scope — and therefore the
// trailing top-level statement — completes. Before the fix the go-thunk was
// emitted as an `Action` that discarded the returned `Task`, so the scope never
// awaited it and "ran" was never observed before "done".

package GSharp.Samples.AsyncGoScopeJoin

import System
import System.Threading.Tasks

async func work() {
    await Task.Delay(1)
    Console.WriteLine("ran")
}

scope {
    go work()
}

Console.WriteLine("done")
