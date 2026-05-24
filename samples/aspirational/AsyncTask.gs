// file: aspirational/AsyncTask.gs
//
// Phase 5 exit sample. Pure async/await interoperating with the BCL `Task`
// surface — `async func` declarations (5.1), `await` (5.1+5.2), and a top-level
// `scope { go runAll() }` (5.7) to drive an async entry point synchronously
// from a script-mode top level. `await Task.Delay(ms)` exercises BCL `Task`
// interop directly. Equivalent shapes work with `Task<T>`-returning APIs
// elsewhere in the BCL.
//
// HttpClient end-to-end interop (constructable imported types, instance member
// access on imported instances) is a Phase-5 polish follow-up — tracked as an
// open item in ADR-0022 §Consequences / coverage-matrix.md. This sample
// demonstrates the *async/await* half of that exit criterion against
// `Task.Delay`; once imported-type construction lands, the same shape applies
// to `HttpClient.GetStringAsync`.

package GSharp.Samples.AsyncTask

import System
import System.Threading.Tasks

async func compute(n int) int {
    await Task.Delay(5)
    return n * 2
}

async func runAll() int {
    let a = await compute(3)
    let b = await compute(4)
    Console.WriteLine("a = $a")
    Console.WriteLine("b = $b")
    return 0
}

scope {
    go runAll()
}

Console.WriteLine("done")
