// file: DefaultExpression.gs
//
// ADR-0100 / issue #795: G# spells the default (zero-initialised) value
// of a type via `default(T)` for any type `T`, and via the bare `default`
// literal in target-typed positions (let/var with explicit type, return
// with known return type, argument to a typed parameter, and conditional
// branches typed by their sibling). Semantics mirror C#:
//   * value types — zero-initialised
//   * reference types and nullable `T?` — `nil`
//   * unconstrained type parameters `T` — emits `initobj T` so both the
//     value-type and reference-type substitutions Just Work
//
// The bare arm-leader `default` inside `switch` / `select` is unchanged
// (context-dependent parse — the arm-leader is recognised before
// expressions are tried).

package GSharp.Example.DefaultExpression

import System

func makeZero() int32 {
    return default
}

func echo(x int32) int32 {
    return x
}

func MakeZero[T]() T {
    return default(T)
}

// `default(T)` for built-in value types — zero-initialised.
Console.WriteLine(default(int32))                  // 0
Console.WriteLine(default(int64))                  // 0
Console.WriteLine(default(float64))                // 0
Console.WriteLine(default(bool))                   // False

// `default(T)` for reference types — `nil`.
let s string = default(string)
Console.WriteLine(s == nil)                        // True

// `default(T?)` for nullable value types — `nil`.
let n int32? = default(int32?)
Console.WriteLine(n == nil)                        // True

// Bare `default` in a let with an explicit type clause.
let zero int32 = default
Console.WriteLine(zero)                            // 0

// Bare `default` in a return when the function's return type is known.
Console.WriteLine(makeZero())                      // 0

// Bare `default` as an argument to a typed parameter.
Console.WriteLine(echo(default))                   // 0

// Bare `default` in a conditional branch, typed by its sibling.
let pick = true ? 42 : default
Console.WriteLine(pick)                            // 42

// `default(T)` inside a generic function — the reified-generics emit
// pass (ADR-0087) produces `ldloca; initobj T; ldloc` so the same body
// produces a zero `int32` and a `nil` `string` depending on the
// substituted type argument.
Console.WriteLine(MakeZero[int32]())               // 0
Console.WriteLine(MakeZero[string]() == nil)       // True
