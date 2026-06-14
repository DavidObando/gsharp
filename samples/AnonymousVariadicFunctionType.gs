// file: AnonymousVariadicFunctionType.gs
// ADR-0102 follow-up / issue #818 — variadic parameters in anonymous
// function-type clauses. A local typed `(int32, ...string) -> int32`
// accepts the same pack / pass-through call shapes a named variadic
// delegate does (samples/VariadicDelegate.gs), without needing a
// declared delegate type.

package GSharp.Example.AnonymousVariadicFunctionType

import System

// Field-typed variable: the slot's type is the anonymous variadic
// function-type. The bound lambda is regular-form; the binder bridges
// the variadic-flag-only difference.
let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

// Auto-pack: trailing positional args become a fresh []string slice.
Console.WriteLine(f(1, "a", "b", "c"))

// Pass-through: a single trailing []string flows through unchanged.
Console.WriteLine(f(10, []string{"x", "y"}))

// Empty pack: body sees an empty slice (Length == 0).
Console.WriteLine(f(7))

// No-fixed shape: `(...T) -> R` works too — every positional argument
// participates in the pack.
let g (...int32) -> int32 = (xs) -> xs.Length
Console.WriteLine(g(1, 2, 3, 4, 5))
Console.WriteLine(g())
