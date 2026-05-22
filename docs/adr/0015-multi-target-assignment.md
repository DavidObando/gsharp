# ADR-0015: Multi-target assignment evaluation order

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 2 (statement form)
- **Related**: execution plan §2.3

## Context

GSharp's Phase 2.3 introduces multi-target short declaration (`a, b := 1, 2`) and multi-target assignment (`a, b = b, a`). Both forms accept N right-hand expressions for N targets (the `f() returning a tuple` shape is deferred to Phase 4 alongside multi-return functions). Two questions need a single committed answer:

1. In what order are the right-hand-side expressions evaluated?
2. When are the writes to the left-hand targets observable?

Go's spec is unambiguous: all RHS expressions are evaluated left-to-right into temporaries _before_ any assignment happens, then writes occur left-to-right. This means `a, b = b, a` swaps correctly even when `a` and `b` alias.

## Decision

GSharp adopts **Go-style semantics**:

- For `a, b, … = e1, e2, …`: each `ei` is evaluated left-to-right into a synthesized read-only temporary (`<>m_<pos>_<i>`). After all RHS evaluations complete, each target is assigned from its corresponding temporary in left-to-right order.
- For `a, b, … := e1, e2, …`: each `ei` is evaluated left-to-right; the new locals are introduced into the current scope and initialised in the same order. No pre-existing variables with these names participate in evaluation (per short-declaration rules).
- If any RHS expression throws, no assignment is observable. (This is a consequence of evaluating all RHS expressions before any write.)
- A target / source count mismatch is a binder diagnostic (`ReportMultiAssignmentMismatch`).

## Consequences

- `a, b = b, a` swaps cleanly.
- `i, a[i] = i+1, "x"` writes to the slot named by the original value of `i`, not the post-increment value — matching Go's well-known rule.
- The temporaries are emitted as ordinary locals in the bound tree, so the existing emitter and interpreter need no per-multi-assignment changes.

## Alternatives considered

- **C# tuple-deconstruction semantics**: similar end result (deconstruction evaluates RHS before writes) but with implicit `ValueTuple` boxing. Rejected for Phase 2 — Phase 4 will introduce tuples explicitly, at which point `let (a, b) = f()` becomes the canonical tuple-bind form and the present multi-target syntax remains a thin sugar that avoids an intermediate tuple.
- **Right-to-left or unspecified evaluation order**: rejected; multi-target assignment is a teaching feature, and unspecified order leads to subtle bugs that a beginner-friendly language should not invite.
