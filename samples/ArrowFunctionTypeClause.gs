// file: ArrowFunctionTypeClause.gs
//
// ADR-0075 / issue #715: the canonical function-type-clause syntax is
// `(T1, T2, ...) -> R`. This sample exercises the new spelling everywhere
// a type clause can appear:
//   * local variable types (`var op (int32, int32) -> int32 = ...`)
//   * function parameter types (`func apply(f (int32) -> int32, ...) ...`)
//   * function return types (`func mkAdder(...) (int32) -> int32 { ... }`)
//   * the async modifier (`async (T) -> R` lowers to `(T) -> Task[R]`)
//   * multi-return shapes via a tuple return type (`() -> (T1, T2)`)
//   * void-returning shapes (`() -> void`)
//
// Function *declarations* (`func name(...) R { ... }`) and function-literal
// expressions (`func(x int32) int32 { return ... }`) keep the `func` keyword
// — only the *type* spelling changes.

package GSharp.Example.ArrowFunctionTypeClause

import System
import System.Threading.Tasks

// A function parameter whose type uses the canonical arrow form.
func apply(f (int32) -> int32, v int32) int32 {
    return f(v)
}

// A function whose return type uses the canonical arrow form.
func makeAdder(delta int32) (int32) -> int32 {
    return (x int32) -> x + delta
}

// `(string) -> (string, int32)` — the return slot is a tuple type clause.
func split(s string) (string, int32) {
    return (s, s.Length)
}

// A local of arrow-function type, initialized with an arrow lambda
// (ADR-0074) — the lambda assigns to the new function-type without any
// wrapping or conversion ceremony.
var op (int32, int32) -> int32 = (a int32, b int32) -> a + b
Console.WriteLine(op(20, 22))

// Pass an arrow lambda through an arrow-function-typed parameter.
Console.WriteLine(apply((x int32) -> x * 3, 14))

// Use a function whose return type is an arrow function.
var addTen = makeAdder(10)
Console.WriteLine(addTen(5))

// Hold a multi-return function in a variable whose type spells the tuple-
// return shape in the canonical arrow form.
var splitter (string) -> (string, int32) = split
var tup = splitter("hello")
Console.WriteLine(tup.Item1)
Console.WriteLine(tup.Item2)

// async (T) -> R lowers to (T) -> Task[R]. Assign an async lambda to a
// local typed as `async (...) -> R` — the two spellings produce the same
// FunctionTypeSymbol so the assignment is direct.
var cb async (int32) -> int32 = async func(x int32) int32 { return x + 100 }
Console.WriteLine(cb(7).Result)

// Void-returning function-type clauses spell their return type as `void`.
var greet () -> void = () -> Console.WriteLine("hello")
greet()
