# ADR-0137: Nullable function type spelling

- **Status**: Accepted
- **Date**: 2026-06-28
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0001 (nullable types `T?`), ADR-0075 (arrow function type clause), issues [#1399](https://github.com/DavidObando/gsharp/issues/1399), [#914](https://github.com/DavidObando/gsharp/issues/914)

## Context

G# uses `T?` for nullable types. Function types already use arrow spelling:
`(T) -> R`. That makes `(T) -> R?` naturally read as a function whose return
value is nullable.

Issue #1399 exposed an ambiguity for nullable function values. A previous fix made
`(T) -> void?` a void-only special case for a nullable delegate, but that conflicts
with the general rule that `?` after `R` belongs to the return type. It also does
not scale to non-void returns such as `(T) -> int32?`.

## Decision

Use parentheses to put `?` on the function type itself:

- `(T) -> R?` means a non-null function returning `R?`.
- `((T) -> R)?` means a nullable function returning `R`.
- `((T) -> R?)?` means a nullable function returning `R?`.

The same rule applies to async function type clauses: `async ((T) -> R)?` is a
nullable async function type, while `async (T) -> R?` has a nullable result.

## Options considered

1. **Keep `(T) -> R?` as nullable function type.** Rejected because it is
   ambiguous with nullable return types and makes `(T) -> int32?` impossible to
   read consistently.
2. **Use `((T) -> R)?`.** Chosen because it follows the existing nullable-type
   rule: parenthesize the type expression that `?` should apply to.
3. **Make function/delegate values nullable by default.** Rejected. Delegates stay
   non-null by default for safety and consistency with G#'s non-null reference
   model tracked by #914; nullable function slots must be explicit.

## Consequences

The parser accepts a parenthesized arrow function type followed by an optional
`?`. Binder and emit no longer need a nullable-void special case: nullable
function slots are represented as `NullableTypeSymbol(FunctionTypeSymbol(...))`,
and nullable returns remain on `FunctionTypeSymbol.ReturnType`.

Existing code that used `(T) -> void?` intending a nullable delegate must migrate
to `((T) -> void)?`. Code that meant a nullable return keeps the direct spelling
`(T) -> R?`.
