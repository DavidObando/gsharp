// file: NullableFlow.gs
//
// Phase 6.6 sample. Demonstrates nullable flow analysis with a type-pattern
// switch and an if-guard on a nullable string.

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
