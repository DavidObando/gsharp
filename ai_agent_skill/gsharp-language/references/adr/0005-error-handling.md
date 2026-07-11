# ADR-0005: Error handling — exceptions only, unchecked

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 3 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.3; execution plan §0 D5, §3.D; design doc D5

## Context

GSharp today has neither Go's `(T, error)` multi-return nor .NET exceptions. The choice of error model is foundational: it shapes every BCL interaction, every API design pattern, and the language's null story.

Constraints:

- The .NET BCL throws exceptions for everything from `FormatException` to `OperationCanceledException`. Any model must coexist with this reality.
- Go's `(T, error)` is the language's most distinctive control-flow pattern and a stated GSharp inspiration.
- Kotlin and C# both ship exceptions without checked-exception declarations; this is the empirical winning design for "managed runtime with rich library ecosystem."

## Decision

**Exceptions only, unchecked.**

- `try` / `catch` / `finally` with multiple typed catch arms.
- `throw expr` statement.
- No `throws` clauses on function signatures. No checked exceptions.
- No `(T, error)` multi-return idiom; users who want value-style error handling use `Result[T, E]` built on `sealed interface` (a library type, not a language feature).
- BCL exceptions propagate unchanged through GSharp code.
- `using` declarations (Phase 3.D.3) and `defer` (Phase 7.1) provide RAII-style cleanup; the two converge semantically.

## Consequences

Positive:

- Zero impedance mismatch with the BCL.
- One mechanism instead of two; no ecosystem fragmentation.
- Frees the type system to focus on nullability (ADR-0001) without doubling up "absence" with "failure."

Negative:

- Cannot statically guarantee exhaustive error handling. Mitigation: encourage `Result[T, E]` + sealed types + exhaustive `switch` for domains where this matters.
- Loses some of Go's explicit-control-flow appeal. Accepted as the cost of BCL interop.

Neutral:

- Stack traces, exception filters, and `AggregateException` semantics come from .NET unchanged.

## Alternatives considered

- **Exceptions + `(T, error)`** as an opt-in idiom: rejected; two error models in the same language fragments the ecosystem and doubles the cognitive load.
- **Go-style only, wrap BCL exceptions at the boundary**: rejected; every BCL call needs a wrapper, and the boundary is fuzzy in practice.
- **`Result[T, E]` as the primary mechanism**: revisited — it is allowed as a user-level pattern but not the language default.
