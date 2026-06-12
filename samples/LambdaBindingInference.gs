// file: LambdaBindingInference.gs
//
// ADR-0076 / issue #716: when a `let` or `var` binding is initialized
// with a lambda whose parameter types are all spelled out, the binding's
// type is inferred to be the lambda's function type `(T1, ...) -> R`.
// The user writes the parameter types once and the binding picks them
// up — no second copy of the function-type clause is required.
//
// Compare this sample to ArrowFunctionTypeClause.gs, where the same
// lambdas appear with their function-type clauses spelled explicitly
// on the binding. Both spellings produce the same FunctionTypeSymbol.

package GSharp.Example.LambdaBindingInference

import System

// Single-parameter inference — `square` binds to `(int32) -> int32`.
var square = (n int32) -> n * n
Console.WriteLine(square(5))

// String identity — `id` binds to `(string) -> string`.
let id = (s string) -> s
Console.WriteLine(id("hello"))

// Multi-parameter — `add` binds to `(int32, int32) -> int32`.
let add = (a int32, b int32) -> a + b
Console.WriteLine(add(20, 22))

// Zero-parameter — `always42` binds to `() -> int32`.
let always42 = () -> 42
Console.WriteLine(always42())

// Block body with an explicit `return` — the return-type rule (ADR-0076
// §3) picks the common type of every value-producing return path. Here
// the only return yields int32, so `inc` binds to `(int32) -> int32`.
let inc = (n int32) -> { return n + 1 }
Console.WriteLine(inc(41))

// Void return — when the body's only effect is a void-returning method
// call, the inferred return type is `void`. `log` binds to
// `(string) -> void`.
let log = (msg string) -> Console.WriteLine(msg)
log("from log")

// Capture — closures still capture their enclosing locals. `addBase`
// binds to `(int32) -> int32` and reads `base` from its enclosing scope.
let base = 100
let addBase = (n int32) -> n + base
Console.WriteLine(addBase(7))

// Target-typing (existing path, kept by ADR-0076 §2 case 1): when the
// binding has an explicit function-type, the lambda's parameter types
// may be omitted and are filled from the target.
let twice (int32) -> int32 = (x) -> x * 2
Console.WriteLine(twice(21))
