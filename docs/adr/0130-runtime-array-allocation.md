# ADR-0130: `[n]T` runtime/zero-initialised array allocation

- **Status**: Accepted
- **Date**: 2026-06-27
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0124 (`stackalloc [n]T` G#-style array grammar), issues [#1016](https://github.com/DavidObando/gsharp/issues/1016) (range/slice backing allocation), [#1046](https://github.com/DavidObando/gsharp/issues/1046) (nested element type clauses), [#1272](https://github.com/DavidObando/gsharp/issues/1272)

## Context

G# spells array/slice literals with a bracketed prefix: `[N]T{e1, …, eN}` for a
constant-length array and `[]T{e1, …}` for a slice (length inferred). There was
no surface syntax for the common case of allocating a **zero-initialised** array
of a **runtime** (or constant) length without listing every element — the
Go-style `make([]T, n)`. Until now:

- `[5]int32{}` was rejected (`GS0115` — "expects 5 initialisers but got 0"),
- `[n]int32{}` did not parse at all (`GS0005` — "expected NumberToken"), and
- the only way to get a zero-initialised array was a constant-length *declaration*
  default (`var a [5]int32`).

Because of this gap, the `cs2gs` translator lowered C# `new T[n]` (no
initializer) to the BCL call `System.GC.AllocateArray[T](n)` (issue #1272),
which is non-idiomatic and leaks an implementation detail into translated G#.

The gsc backend already supported a runtime-length, zero-initialised allocation:
`BoundArrayCreationExpression` carries an optional `LengthExpression` (added for
issue #1016 slicing), and `MethodBodyEmitter` lowers it to a CIL `newarr`
(which zero-initialises every element). Only the **front-end** (parser + binder)
and the translator were missing.

## Decision

### 1. Syntax — `[n]T` allocation form

The array-creation expression `[n]T` (and the equivalent empty-initializer
spelling `[n]T{}`) is the **runtime/zero-initialised allocation** form, where
`n` is an **arbitrary expression** (a runtime length is allowed, not just a
numeric literal) and there are **no** element initialisers. It yields a fresh,
zero-initialised slice `[]T` of length `n`.

`ArrayCreationExpressionSyntax` gains an optional length
`ExpressionSyntax LengthExpression` (alongside the existing literal
`LengthToken`) and makes the brace initializer optional. The parser
(`ParseArrayCreationExpression`) keeps the existing shapes byte-for-byte:

- `[N]T{e1, …, eN}` — a lone numeric literal length immediately followed by `]`
  is still captured as the literal `LengthToken`, preserving the constant-count
  `GS0115` check.
- `[]T{e1, …}` — empty brackets still infer the length from the initializer
  (slice literal).
- `[][]int32{…}` and other nested element type clauses (issue #1046) are
  unchanged.

The new form is selected when, after `]` and the element type, the next token is
**not** `{` (no initializer), **or** an **empty** `{}` follows a length. A
non-literal bracket length (`[n]`, `[n + 1]`, …) is parsed as a full
`LengthExpression`. `[` in primary-expression position is unambiguously array
creation (indexing is a postfix operation), so no dispatch ambiguity is
introduced.

No new `SyntaxKind` or `BoundNodeKind` is introduced — the existing
`ArrayCreationExpression` kinds are reused.

### 2. Binding

`BindArrayCreationExpression` resolves the element type as before (identifier
lookup, or a nested type clause for issue #1046). When `LengthExpression` is
present it binds the length, converts it to `int32` (the same typing as array
indices and the underlying `newarr`; narrower integer lengths widen
automatically via the implicit numeric widening of ADR-0129), and returns
`new BoundArrayCreationExpression(syntax, SliceTypeSymbol.Get(elementType),
boundLength)`. The result type is therefore `[]T`, and the existing emitter
path produces a `newarr` that zero-initialises every element. The literal
constant-count `GS0115` check is unchanged.

### 3. `cs2gs` translation

`TranslateArrayCreation` lowers C# `new T[n]` (no initializer) to the native
`[n]T` form (a new `ArrayAllocationExpression` code-model node, rendered as
`[<length>]<elementType>`) instead of `System.GC.AllocateArray[T](n)`. C# allows
any integral length (`new T[uint]`, `new T[long]`, …); since gsc's `[n]T`
requires an `int32` length, a non-`int32` length keeps being coerced via the
conversion-call form (`int32(n)`), e.g. `[int32(n)]T`. The `new T[]{…}`
initializer form is unaffected and keeps mapping to the slice literal `[]T{…}`.

## Consequences

- `func zeros(n int32) []int32 { return [n]int32 }` compiles and yields a
  zero-initialised `[]int32` of length `n`; `[5]int32` (constant) and
  `[n]int32{}` (empty-initializer spelling) behave identically.
- `cs2gs` emits idiomatic `[n]T` for `new T[n]`, replacing the
  `System.GC.AllocateArray[T](n)` BCL call (the deliverable of issue #1272).
- The existing literal (`[N]T{…}`), slice (`[]T{…}`), and jagged
  (`[][]int32{…}`) forms are unchanged, as is the `GS0115` constant-count check.
- No new `SyntaxKind`/`BoundNodeKind` was added; the coverage matrix and the
  exhaustiveness allowlists are unaffected.
