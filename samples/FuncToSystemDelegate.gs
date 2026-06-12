// file: FuncToSystemDelegate.gs
//
// Issue #323: a Func[...] (or native (T) -> R) value widens implicitly to
// System.Delegate (the common base of every delegate). This used to fail with
// `error GS0155`. Both forms are exercised:
//   * the var form: a named/generic delegate value assigned to a Delegate slot
//   * the lambda-literal form: a func literal assigned directly to a Delegate
// The resulting System.Delegate values expose their target method, proving the
// widening is a correct reference upcast at runtime.

package GSharp.Samples.FuncToSystemDelegate

import System

// var form: a named generic delegate value widens to System.Delegate.
var f Func[string] = func() string { return "hi" }
var d Delegate = f

// lambda-literal form: a func literal assigned straight to a Delegate slot.
var g Delegate = func() string { return "yo" }

Console.WriteLine(d.Method.Name)
Console.WriteLine(g.Method.Name)
