# ADR-0032: Data-struct ergonomics polish

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 7.3
- **Related**: execution plan row 7.3; ADR-0029 data-struct synthesized members; ADR-0031 contextual `in`

## Context

Phase 7.3 completes the ergonomic surface around `data struct`. ADR-0029 established data-struct equality, `ToString`, hash behavior, and a synthesized `Deconstruct` contract, but left the consumer syntax for copying and destructuring open. Users need a concise way to produce a modified value without mutating the original, and they need deconstruction forms that consume the field order already declared on the data struct.

## Decision

Add three ergonomic surfaces for `data struct`: method-style `.copy(F = v, …)`, positional deconstruction `let (a, b) = p` plus named deconstruction `let { F = a, G = b } = p`, and `let p2 = p with { F = v }`. `.copy(...)` is parser-recognized sugar scoped to data-struct receivers; named arguments are accepted in the general argument parser but the binder diagnoses them unless the callee is exactly `.copy` on a data struct. `with` is a contextual keyword recognized only as `expr with { … }`, so `with` remains usable as an identifier elsewhere.

Both `.copy(...)` and `with { … }` lower to the same struct-literal pattern. The binder captures the receiver in a synthesized readonly `$`-prefixed local, then builds a `BoundStructLiteralExpression` for the same data-struct type; explicit overrides supply their bound values and unspecified fields read from the captured receiver via field access. Positional deconstruction binds fields by declaration order and named deconstruction binds each requested field by name, with unknown and duplicate names diagnosed; both deconstruction forms preserve single-evaluation of the RHS through the same synthesized readonly local pattern as tuple deconstruction. CLR `Deconstruct(out …)` consumption is not generalized in this phase; positional deconstruction is extended only for GSharp `data struct` values.

## Rationale

The trio mirrors familiar Kotlin data-class and C# record workflows while staying within GSharp's existing runtime model. Users can choose terse positional deconstruction, explicit named deconstruction, or copy/update syntax depending on readability. Reusing struct-literal lowering keeps the evaluator, lowerer, and emitter centered on `BoundStructLiteralExpression` rather than adding bespoke runtime support for a synthesized method body.

## Consequences

ADR-0029's runtime contract is unchanged: no public `copy` method is emitted or required for correctness. The implementation adds only the minimal bound block-expression wrapper needed to preserve single-evaluation in expression position; the actual copied value remains a `BoundStructLiteralExpression`. `with` is contextual: it is recognized only when an expression is followed by identifier text `with` and an opening brace, so existing variables named `with` remain valid outside that disambiguated form.

## Alternatives considered

Full named arguments were rejected as Phase-7.3 scope creep because general call-site named arguments need overload resolution, default-argument semantics, and diagnostics beyond data-struct copy. A brace-only `.copy { F = v }` form was rejected because it collides visually with struct-literal syntax while still needing a special receiver rule. Removing positional `let (a, b) = data` in favor of named-only deconstruction was rejected because positional deconstruction is the common Kotlin/C# spelling and follows the already-synthesized field declaration order.
