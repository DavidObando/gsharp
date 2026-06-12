# ADR-0064: If-expression and block-with-trailing-expression value forms

- **Status**: Accepted
- **Date**: 2026-06-10
- **Implemented**: 2026-06-10 (PR [#680](https://github.com/DavidObando/gsharp/pull/680), issue [#669](https://github.com/DavidObando/gsharp/issues/669))
- **Finalized**: 2026-06-11 (issue [#711](https://github.com/DavidObando/gsharp/issues/711))
- **Phase**: Phase 8 — language ergonomics / expression surface
- **Related**: ADR-0062 (generalized ternary), ADR-0009 (switch semantics), issues #669, #706, #711

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

## Addendum (issue #711, 2026-06-11)

Issue #711 finalises ADR-0064. The following points were left implicit in the
original ADR and are now pinned down:

- **Branch-tail value form.** The trailing expression of a block is the last
  *expression statement* of the block, lifted out and used as the block's
  value. There is no `yield` keyword on this path; ADR-0064 is the
  expression-position counterpart to the existing switch-expression form, and
  switch-expression arms also have no `yield`. (G#'s `yield` is reserved for
  iterator state-machine bodies — see ADR-0030.)
- **Statement-form preservation.** Existing `if` statements MUST still parse
  and behave unchanged. The parser disambiguates by call-site: the primary
  expression slot tries an if-expression parse first; `ParseIfStatement` is
  only reached from `ParseStatement`. An if-expression in expression position
  requires an exhaustive `else` chain (GS0276); an if used as a statement may
  omit `else`.
- **Common-type rule.** The result type is the common type of all branch
  tails, computed by the same `ComputeConditionalCommonType` helper that
  ADR-0062 uses for the ternary. Branch tails are then implicitly converted
  to that result type. Mismatched branch types report GS0263 (the same code
  the ternary uses), so users see one consistent diagnostic.
- **Interaction with the switch expression.** A switch-expression arm and an
  if-expression branch follow the *same* common-type rule, so the two forms
  compose cleanly: a `switch { ... }` value may be the trailing expression of
  a block, and an `if … else if … else …` chain may sit in an arm body.
- **`throw` in a branch tail.** `throw` is a *statement* in G#, not an
  expression (the switch expression does not accept `throw` as an arm value
  either). To exit on the error path of an if-expression, place a `throw`
  statement in the block prefix and supply a (possibly unreachable) tail
  expression of the chosen result type, or — more idiomatically — wrap the
  call site in a `func`/`guard let`. This is identical to the switch-
  expression treatment.
- **Reference-vs-value branch types.** Branch tails of different types share
  the common-type rule above; a value type and a reference type unify only
  when one is implicitly convertible to the other (e.g. `T` to `object`).
  Without a common type the binder reports GS0263.
- **Flow narrowing (ADR-0069) and `if let` (ADR-0071).** The expression-form
  if-expression does not introduce a new narrowing or binding shape — it
  reuses the existing `IfExpressionSyntax`/`BlockExpressionSyntax` plumbing
  that was already wired through the binder, so smart-cast narrowing of
  variables tested in the condition still applies inside both branches.
  `if let` and `guard let` remain *statement* forms (ADR-0071); the
  expression form does not subsume them and they continue to parse via
  `ParseIfLetStatement` / `ParseGuardLetStatement`.
- **Block-as-expression rules.** A `{ stmt*; tailExpr }` block in value
  position requires a non-empty tail (GS0277). A block with only statements
  is still legal in *statement* position via `BlockStatementSyntax`; only the
  expression-position lifting needs a tail.
- **Coverage parity.** The compiler emit path and the interpreter both lower
  through `BoundConditionalExpression` / `BoundBlockExpression`, so no
  backend-specific work was required; tests cover both paths.
