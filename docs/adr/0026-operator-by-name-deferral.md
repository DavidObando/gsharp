# ADR-0026: Operator-by-name on user types — deferred

- **Status**: Accepted (deferral)
- **Date**: 2026-05-24
- **Phase**: Phase 6
- **Related**: ADR-0019 (extension functions); ADR-0024 (methods vs extensions canonical style); ADR-0029 (data struct synthesized members); execution plan §6.5

## Context

Phase 6.5 of the execution plan asks whether GSharp should adopt Kotlin-style operator-by-name on user types, where a method named `plus`, `minus`, `times`, `compareTo`, etc. on a user type becomes the implementation of the corresponding `+`, `-`, `*`, `<`/`<=`/`>`/`>=` operator at the call site. The plan itself recommends keeping this feature off unless a strong use case emerges, and if shipped, scoping it tightly to value types.

The surrounding context after Phases 5 and 6 is:

- `data struct` instances already get `==` / `!=` via ADR-0029 synthesized members, so structural equality is solved without operator-by-name.
- Reference-typed `class` instances use reference equality by default, which matches CLR norms.
- The set of user types where operator overloading is genuinely valuable in real-world GSharp code today is small (essentially numeric value types and unit-of-measure wrappers). None of the conformance samples need it.
- The CLR provides `op_Addition`, `op_Subtraction`, `op_Equality`, etc. as the standard interop spelling for operator overloads. Any future GSharp design must round-trip cleanly to those names so imported BCL types whose operators are overloaded continue to behave consistently from GSharp call sites.

## Decision

Defer operator-by-name on user types. No syntax, binder, or emit work ships in Phase 6 for this feature. The execution plan row 6.5 closes as deferred-with-ADR.

Concretely:

- Source code containing `func (p Point) plus(o Point) Point { … }` continues to declare a regular method named `plus`. There is no implicit reinterpretation as `op_Addition`. Call sites must write `p.plus(q)`, not `p + q`.
- The binder's binary-operator resolution continues to require a `BoundBinaryOperator` table entry for each operand-type pair. User types are not eligible operands except where ADR-0029 already permits (`==` / `!=` on `data struct`).
- Imported CLR types with overloaded operators are unaffected by this decision; their operator surface is handled by the existing import path (and is itself currently a coverage-matrix gap separate from 6.5).

## Consequences

Positive:

- Phase 6 closes without taking on an open-ended overload-resolution surface that interacts with ADR-0020 generic-bracket lookahead, nullability narrowing, and exhaustiveness in non-obvious ways.
- The language stays small and predictable. Users who reach for `+` on user types have an unambiguous answer: use a named method.
- Future revisitation is cheap because no transitional or partial implementation exists to deprecate.

Neutral:

- C# `operator +` / Kotlin `operator fun plus` familiarity remains an open ergonomic gap for numeric-DSL authors. The deferred-with-ADR status is intentional, not a rejection.

Negative:

- Numeric-DSL and unit-of-measure wrappers cannot express `a + b` natively; users write `a.plus(b)` or a free function `add(a, b)`.

## Re-opening criteria

This ADR should be revisited when at least two of the following hold:

- A conformance sample or external user report demonstrates that a named-method workaround materially degrades readability of code GSharp is meant to express well (numeric DSLs, geometry libraries, unit-of-measure types).
- Generic-method support on user-defined receivers (deferred in ADR-0024) has shipped, so an operator-by-name overload set has a coherent generic story.
- A concrete design exists that pins down: which operators are eligible (likely arithmetic and ordering only, never logical or short-circuiting); which receiver kinds are allowed (likely value types only, matching the plan's recommendation); how the binder picks between an imported CLR `op_Addition` and a user-defined `plus` method on the same type; and the round-trip to CLR `op_*` names for cross-language interop.

When those preconditions are met, a follow-up ADR will supersede this one with the chosen design.

## Alternatives considered

Ship the feature in Phase 6 scoped to value types only. Rejected for this phase because the value over `a.plus(b)` is small relative to the binder and overload-resolution surface added, and because the design interacts with deferred items from ADR-0024 (generic receivers) that should land first.

Ship the feature via attribute opt-in such as `[OperatorOverload("+")]`. Rejected because it adds attribute-driven binder behavior to a language that otherwise does not rely on attributes for core semantics, and because it does not address the underlying overload-resolution questions.

Reject the feature outright. Rejected because the plan explicitly leaves the door open ("unless a strong use case emerges"), and a permanent rejection would foreclose a future low-cost win.
