# ADR-0013: Drop Go's `fallthrough` (cases never fall through)

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 2 (statement form), Phase 6 (expression form)
- **Related**: ADR-0009 (`switch` semantics); execution plan §2.6, §2.9

## Context

Go's `switch` cases do not fall through by default (unlike C / C++), but a case body can opt back into fall-through with a trailing `fallthrough` statement. C#, Kotlin, Rust, and Swift all reject implicit fall-through; C# specifically prohibits fall-through and forces an explicit `goto case` for the rare cases where it's desired.

ADR-0009 already locked GSharp's switch semantics to "C#/Kotlin-shaped, no implicit fallthrough." This ADR closes the loop on what happens to the Go-inherited `fallthrough` keyword.

## Decision

- `switch` cases do not fall through, and **GSharp does not provide any opt-in form** of case fall-through.
- The `fallthrough` token continues to be **reserved** (it is already in `SyntaxFacts.GetKeywordKind`); using it anywhere in source produces a parser diagnostic ("`fallthrough` is not supported (ADR-0013)").
- Cases that genuinely want to share a body should either duplicate the body, factor it into a helper function, or — once Phase 6 ships multi-value cases — list multiple values in a single arm.

## Consequences

Positive:

- Removes the highest-rated footgun in Go's switch. Cases are independent units; reordering them never changes behaviour.
- No need to design `goto case` syntax now or later.
- Keeps the bound representation simple: each case is an independent body, lowered to one branch of an if/else chain in Phase 2.

Negative:

- Programs ported from Go that depend on `fallthrough` need rewriting. Mitigation: the parser diagnostic points directly at the offending token.

Neutral:

- The reserved keyword stays reserved (never recycled for other uses) so the diagnostic remains stable across the language's lifetime.

## Alternatives considered

- **Allow `fallthrough` (Go-faithful)**: rejected; introduces ordering-sensitive bugs that the rest of GSharp's design works hard to avoid.
- **C#-style `goto case <value>`**: rejected for Phase 2; the cost of an opt-in mechanism outweighs the (very small) demand. Can be revisited if real usage emerges.
- **Unreserve the keyword**: rejected; users will type `fallthrough` out of muscle memory; a clear diagnostic beats an opaque "unknown identifier" error.
