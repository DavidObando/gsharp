// file: aspirational/NullableFlow.gs
//
// Phase 6.6 sample. Nullable flow-analysis is binder/interpreter-covered;
// emit for pattern switches remains deferred with the rest of Phase 6 patterns.

package GSharp.Samples.NullableFlow

import System

let opt string? = "hello"
switch opt {
case s is string { Console.WriteLine(opt.Length) }
case _ { Console.WriteLine("nothing") }
}

let s string? = "world"
if !String.IsNullOrEmpty(s) {
  Console.WriteLine(s.Length)
}
