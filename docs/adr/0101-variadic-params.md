# ADR-0101: Variadic (`...T`) parameter declarations

- **Status**: Accepted
- **Date**: 2026-07-11
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #799 (G# cannot author variadic methods; `Sequences.Of` is consumable but not portable)
- **Related**: Parent #706 (G# Language — Current State and Design Opportunities); #792 (dogfooded `Optional`/`Sequences` port); ADR-0084 (slice type `[]T`); ADR-0063 (overload resolution & generic inference)

## Context

G# call-binding has long recognised the CLR `ParamArrayAttribute`, so
`Sequences.Of("a", "b", "c")` already works because the consumed helper
is C#-authored. What G# could not do was *author* a variadic method:
a `func Of[T](values []T) []T` accepts a slice but forces the caller
to wrap their arguments, and there was no source-level spelling that
made the parser, binder, and emitter cooperate to treat the trailing
arguments as a parameter pack.

This bites the dogfood port of the standard library helpers
(`Optional[T]`, `Sequences[T]`, #792) — the goal of that port is to
replace the C# implementations with G# while preserving the public API
shape, and `Sequences.Of<T>(params T[])` is the headliner. Without a
G# variadic spelling, the dogfooded helper either has to drop the
ergonomic call shape or stay in C# indefinitely.

The Phase 4.8 scaffolding (parser ellipsis token, `IsVariadic` flag on
`ParameterSymbol`, binder wrap in `SliceTypeSymbol`, packing in
`OverloadResolver`, `GS0145`/`GS0146`/`GS0147` diagnostics) made
variadic parameters parseable and partially bindable, but it was
incomplete: generic inference did not propagate the element type from
the trailing arguments, a caller passing a single `[]T` directly got
double-wrapped, and the emitted MethodDef carried no metadata bit
telling C# / F# / VB consumers that the parameter was a parameter
array. This ADR completes the design and commits to it.

## Decision

### Canonical spelling

The G# spelling for a variadic parameter is

```
name ...T
```

— that is, the ellipsis token sits **between the parameter
identifier and the element type**, mirroring Go's `name ...T`. Inside
the function body the parameter has type `[]T` (a slice).

Rationale for the position:

- Putting `...` after the *name* makes the variadic-ness an attribute
  of the parameter declaration, not of the type — this matches G#'s
  Go-influenced declaration grammar (`name Type`) and avoids a
  confusing `...[]T` vs `[]T...` ambiguity.
- It composes cleanly with the existing tokeniser: `...` is already a
  range-expression token; no new lexer state is required.
- The element type is what the author writes (`int32`, `string`,
  `T`), and what they *see* inside the body is the slice (`[]int32`,
  `[]string`, `[]T`) — exactly as in Go.

### Pack vs. pass-through (caller-side semantics)

When the binder resolves a call to a function whose last parameter is
variadic with element type `T`:

1. **Pack**: if the call site supplies *N ≥ 0* trailing positional
   arguments and none of them already has type `[]T`, the binder
   synthesises a `BoundArrayCreationExpression` of length `N` and
   places the trailing arguments inside; the callee sees a freshly
   allocated `[]T`. `N == 0` packs into an empty array — `Sequences.Of()`
   sees an empty slice, not `nil`.
2. **Pass-through**: if the call site supplies **exactly one trailing
   argument** whose type equals the variadic slice type `[]T` (after
   generic substitution), the bound argument is forwarded unwrapped.
   The callee receives the same array reference the caller passed —
   mutations are visible on both sides, just as C#'s `params` allows.

This is the C# `params` rule, and it gives both ergonomics
(`Sequences.Of(1, 2, 3)`) and zero-copy interop with code that already
holds a `[]T` (`Sequences.Of(existingSlice)`).

### Generic inference

For a variadic generic function `Of[T](values ...T)`:

- If the call site provides multiple trailing arguments, `T` is
  inferred from each element in turn (just like a normal parameter,
  but iterated).
- If the call site provides exactly one trailing argument whose type
  is `[]U`, `T = U` is inferred from the slice element type — so
  `Of(arr)` where `arr : []int32` infers `T = int32` and *passes
  through* `arr`.
- If the call site provides zero trailing arguments, `T` falls back
  to explicit type arguments (`Of[int32]()`); otherwise it is an
  inference failure, identical to today's behaviour for any
  uninferrable type parameter.

### Cross-language interop — `ParamArrayAttribute`

The emitter stamps `[System.ParamArrayAttribute]` on the last
parameter of any G# `func` whose source declared it variadic. This
makes the symbol indistinguishable, from the C# / F# / VB callers'
perspective, from a hand-written `params T[]` parameter — the
emitted method participates in their language's variadic call rules
without any additional cooperation. The G# binder's existing recognition
of `ParamArrayAttribute` on consumed BCL methods means a G# author and
a C# author can interchangeably consume each other's variadic
declarations.

### Where variadic is allowed in this ADR

Variadic parameters are accepted **only on top-level `func`
declarations** in this ADR. The following sites continue to reject
variadic with `GS0146` (variadic parameter not supported here) until a
follow-up ADR lifts the restriction:

- class instance methods;
- class static methods;
- interface methods and default-interface-method bodies;
- constructors;
- lambdas and arrow functions;
- delegate declarations.

Lifting any of these requires the call-binding machinery
(`BindUserInstanceCall`, virtual dispatch, interface method tables,
the lambda inference rules) to learn the pack/pass-through dance —
none of which is hard but each of which deserves its own ADR. The
class-static case is what the dogfood port of `Sequences.Of` ultimately
needs; this ADR knowingly defers it.

### Structural rules

- A signature may have **at most one** variadic parameter. A second
  triggers `GS0364`.
- The variadic parameter, if present, must be the **last** parameter.
  Otherwise `GS0145`.
- The element type may be any G# type — built-in, user struct, type
  parameter, slice, etc. (The wrap is always
  `SliceTypeSymbol.Get(elementType)`.)
- The C# keyword `params` is **not** accepted. Encountering it
  triggers `GS0363` pointing at the canonical `...T` form. This was a
  deliberate choice over a soft-deprecated alias: the two spellings
  would have had identical lowering and would have invited bikeshed,
  while the cost of the keyword path (lexer change, dual-spelling
  documentation, downstream parser branches) was non-trivial.

## Diagnostics

| ID | Severity | Surface | Meaning |
| --- | --- | --- | --- |
| `GS0145` | Error | Binder | A variadic parameter must be the last parameter of the signature. |
| `GS0146` | Error | Binder | Variadic parameters are not supported on this declaration kind in this ADR. |
| `GS0147` | Error | Binder | Variadic call site is missing trailing arguments where required (typed pass-through cannot resolve). |
| `GS0363` | Error | Parser | The C# `params` keyword is not supported in G#. Use the canonical variadic spelling `name ...T`. |
| `GS0364` | Error | Binder | A signature may declare at most one variadic parameter. |

## Consequences

### Wins

- `Sequences.Of(1, 2, 3)` and equivalents are now expressible from
  G# source, not just from G# call sites that consume C# helpers.
  This unblocks the top-level-function portion of the #792 dogfood
  port immediately.
- Cross-language interop: a G# variadic method is consumable by C# /
  F# / VB with their native variadic syntax — `ParamArrayAttribute`
  carries the contract through the assembly metadata.
- Pass-through preserves array identity, matching C# `params`
  behaviour exactly and avoiding the silent allocation surprise
  C# / Go users would otherwise hit.
- No new `SyntaxKind`, no new `BoundNodeKind`: the variadic
  parameter is just a parameter symbol with an `IsVariadic` flag and
  a slice type. Coverage matrix is unchanged.

### Costs / follow-ups

- Class methods, interface methods, constructors, lambdas, and
  delegates cannot yet declare variadic parameters. The dogfood port
  of `Sequences.Of` (#792) wants `Sequences.Of[T]` on a static class —
  that specific path needs a follow-up ADR before the C# helper can be
  retired. Until then, the dogfood port can use a top-level `func Of`
  in the `Gsharp.Extensions.Sequences` namespace, or continue calling
  the existing C# helper unchanged.
- The parser's `params` rejection is a hard error today. If we ever
  want to soften it to a warning / quick-fix, that is a localized
  parser change in `ParseParameter`.
- The well-known reference cache acquires one more entry
  (`ParamArrayAttribute..ctor`); negligible.

### Non-goals

- This ADR does not introduce a Go-style spread operator at call
  sites (`f(args...)`). G# already lets you pass a `[]T` directly to a
  variadic parameter — that *is* the spread, just spelled by the type
  rather than by a postfix operator.
- This ADR does not touch the existing recognition of CLR
  `ParamArrayAttribute` on consumed BCL methods — that lives in
  `OverloadResolver`'s BCL paths and is unaffected.
