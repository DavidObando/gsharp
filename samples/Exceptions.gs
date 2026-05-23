// file: Exceptions.gs
// Demonstrates Phase 3.D emit coverage: try/catch/finally and throw.

package GSharp.Example.Exceptions

import System

var trace = ""

try {
    trace = trace + "t"
} finally {
    trace = trace + "f"
}

Console.WriteLine(trace)

var caught = "before"
try {
    var n = Int32.Parse("not a number")
} catch (e Exception) {
    caught = "caught"
}

Console.WriteLine(caught)

var trace2 = ""
try {
    var n = Int32.Parse("bad")
} catch (e Exception) {
    trace2 = trace2 + "c"
} finally {
    trace2 = trace2 + "f"
}

Console.WriteLine(trace2)
