# ADR-0064: If-expression and block-with-trailing-expression value forms

- **Status**: Accepted
- **Date**: 2026-06-10
- **Implemented**: 2026-06-10 (PR [#669](https://github.com/DavidObando/gsharp/issues/669))
- **Phase**: Phase 8 — language ergonomics / expression surface
- **Related**: ADR-0062 (generalized ternary), issue #669

## Context

G# has a generalized ternary (`cond ? a : b`, ADR-0062) but no way to write multi-statement conditional expressions or readable `else if` chains in value position. Users coming from Rust, Kotlin, Swift, and F# expect `if` to work as a value-producing expression.

## Decision

Add `if` as a value-producing expression that coexists with the ternary:

```ebnf
IfExpression := 'if' Expression Block ('else' (IfExpression | Block))?
Block        := '{' Statement* (Expression)? '}'
```

- The block's final expression (last expression statement) is the value.
- `if` without `else` is statement-only; using it in value position reports **GS0276**.
- A block without a trailing expression in value position reports **GS0277**.
- `else if` chains are right-associative (nested `IfExpressionSyntax`).
- Common-type/branch-type-unification rules are identical to ADR-0062 ternary.
- Lowers to the same `BoundConditionalExpression` that ternary uses (no new emit logic).
- Multi-statement blocks lower to `BoundBlockExpression` (already exists for interpolated strings and object initializers).

## Examples

```gsharp
let f = if filter != nil { filter!! } else { LibraryFilter() }

let title = if user.IsAdmin {
    log("admin route")
    "Admin Dashboard"
} else {
    "Home"
}

let grade = if pct >= 90 { "A" }
           else if pct >= 80 { "B" }
           else { "C" }
```

## Diagnostics

- **GS0276**: if-expression in value position must have an `else` branch.
- **GS0277**: block in if-expression value position must end with a value-producing expression.

## Consequences

- **Positive**: multi-statement branches and `else if` chains now work in value position.
- **Positive**: no new bound-node kinds; reuses existing `BoundConditionalExpression` and `BoundBlockExpression`.
- **Neutral**: ternary (`?:`) continues to work unchanged (coexistence).
- **Negative**: `if` at expression-level requires the parser to disambiguate struct-literal syntax (`name { }`) from block expressions; resolved via `suppressTrailingObjectInitializer`.
