# ADR-0178: Typed range clauses

- **Status**: Accepted
- **Date**: 2026-09-04
- **Related**: ADR-0031 canonical `for in`; issue #3897 family 3

## Context

G# infers the iteration variable type in `for x in collection`. C# also permits
an explicit `foreach` variable type and applies the foreach element conversion
on every iteration. cs2gs previously represented non-implicit conversions with
a synthetic `__foreachN` variable followed by a cast in the loop body.

## Decision

G# accepts `for x T in collection` and `await for x T in stream`, where `T` is
any type clause. The declared variable has type `T`. Before each body execution,
the source element is converted to `T` using the same explicit conversion rules
as a cast expression. Failed runtime casts throw the normal CLR exception.
Conversions that cannot exist are diagnosed at binding time.

Untyped `for x in collection`, tuple range clauses, and two-variable
key/value range clauses retain their existing behavior. A typed clause applies
only to the single iteration variable.

## Rationale

This matches C# foreach behavior and lets cs2gs preserve an explicit source
type directly:

```gsharp
for inputMatch Match in inputMatches {
    // inputMatch is Match
}
```

The binder lowers the feature through the existing range loop. It stores each
element in the existing source-typed iteration local, then initializes the
user-visible typed variable through the ordinary conversion binder. This
reuses existing conversion and lowering behavior, including user-defined
conversions, without adding a second range-loop representation.

## Consequences

cs2gs emits typed range clauses for explicit C# foreach variable types and no
longer synthesizes `__foreachN` variables. Explicitly typed async foreach
statements use the corresponding `await for x T in stream` form.
