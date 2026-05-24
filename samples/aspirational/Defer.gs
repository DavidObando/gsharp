// file: Defer.gs
// Demonstrates Phase 7.1 block-scoped defer and using cleanup convergence.

package GSharp.Example.Defer

import System
import System.IO

var trace = ""

func record(label string) {
    trace = trace + label + ","
}

{
    defer record("defer-1")
    using let writer = StringWriter()
    writer.WriteLine("using body")
    defer record("defer-2")
    record("body")
    Console.Write(writer.ToString())
}

Console.Write(trace)
