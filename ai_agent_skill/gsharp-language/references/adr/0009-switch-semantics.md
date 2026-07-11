# ADR-0009: `switch` semantics — expression + statement, patterns, exhaustive

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 2 (statement form), Phase 6 (expression + patterns), Phase 0 (lock)
- **Related**: gaps doc §3.2.3, §6.1; execution plan §0 D9, §2.6, §6.1; design doc D9; ADR-0013 (drop fallthrough)

## Context

GSharp reserves both `switch` (from Go) and could reserve `when` (Kotlin's superior selection construct). Picking one canonical keyword avoids two competing constructs.

Go's `switch`: cases match by value or by type-switch, `fallthrough` opts into the C-style fall-through behavior. Statement only.

C#'s `switch`: both statement and expression form, rich pattern matching (constant, type, property, list, relational), exhaustiveness analysis. No implicit fallthrough.

Kotlin's `when`: expression-first, arms can be predicates (`is`, `in`, comparisons), exhaustive over `sealed` hierarchies and enums.

## Decision

**Keep `switch`** as the keyword (no `when`). Semantics borrow from C# and Kotlin:

- **Both statement and expression forms.**
- **Pattern matching** in case arms: constant patterns, type patterns (`case v is T`), property patterns (`case { Name: "x" }`), relational patterns (`case > 0`), list patterns (`case [1, _, 3]`), discard `_`. (Statement form ships in Phase 2 with constant patterns only; expression form and richer patterns in Phase 6.)
- **No implicit fallthrough.** `fallthrough` keyword stays reserved but the parser rejects it (ADR-0013).
- **Exhaustiveness** checked over `sealed interface` hierarchies and `enum` declarations (Phase 6.3). Non-exhaustive `switch` over a sealed type is a binder diagnostic unless a `default` arm is present.

```gs
let label = switch x {
  case 0: "zero"
  case 1, 2, 3: "small"
  case > 100: "huge"
  default: "other"
}

switch shape {
  case c is Circle: draw_circle(c)
  case r is Rect  : draw_rect(r)
}  // exhaustive over sealed Shape — no default needed
```

## Consequences

Positive:

- One construct covers Go's switch, C#'s switch, and Kotlin's `when`.
- Exhaustiveness over sealed types makes ADTs first-class.
- Keeps a keyword GSharp already reserves; no new reserved-keyword churn.

Negative:

- Pattern-matching surface is large; Phase 2 ships only the value-case statement form, Phase 6 lands the rest.
- Bound-tree representation must be designed in Phase 2 to be pattern-aware-but-empty so Phase 6 is additive, not destructive.

Neutral:

- Loses Go's `fallthrough`. Cases that genuinely need fall-through can be expressed by sharing a target via labels (Phase 6 or Phase 7) or by listing values in the same case arm.

## Alternatives considered

- **`when` keyword** (Kotlin-faithful): rejected; `switch` is already reserved, recognized by every C# developer, and equally suitable.
- **Both `switch` (statement) and `when` (expression)**: rejected; two constructs for the same job is a teaching hazard.
- **Go-faithful `switch`** (no patterns, no expression form, with fallthrough): rejected; gives up the pattern-matching ergonomics that motivate the whole phase.
