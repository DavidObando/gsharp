// file: DelegateCallSyntax.gs
//
// Issue #325: a variable whose type is a CLR delegate (e.g. `Func[...]`,
// `Predicate[...]`, `Action`) is invocable with call syntax `f(x)`, exactly
// like a native G# func-typed variable. Previously this required the explicit
// `.Invoke(...)` form and `f(x)` failed with `GS0131: 'f' is not a function`.
// Each delegate below is invoked through call syntax to prove the lowering to
// `Invoke` is correct at runtime.

package GSharp.Samples.DelegateCallSyntax

import System

// Generic Func delegate invoked via call syntax.
var increment Func[int32, int32] = func(x int32) int32 { return x + 1 }
Console.WriteLine(increment(41))

// Two-argument Func delegate invoked via call syntax.
var add Func[int32, int32, int32] = func(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(20, 22))

// Predicate delegate invoked via call syntax.
var isBig Predicate[int32] = func(x int32) bool { return x > 2 }
Console.WriteLine(isBig(5))
Console.WriteLine(isBig(1))

// Parameterless Action delegate invoked via call syntax.
var greet Action = func() { Console.WriteLine("hello from Action") }
greet()

// Call syntax and Invoke produce the same result.
Console.WriteLine(increment(9))
Console.WriteLine(increment.Invoke(9))
