# ADR-0010: Aspirational samples policy — rewrite to today's subset, re-expand per phase

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 0 (policy), every later phase (re-expansion)
- **Related**: gaps doc §5.6; execution plan §0 D10, §0.2; design doc D10

## Context

Two `.gs` artifacts in the tree (`samples/Loop.gs` and the Loop example in `design/Gsharp-design-v0.1.md`) use syntax that does not parse today: C-style `for init; cond; post`, `i--`, `args[0]` indexing, `*count`, and `"{i}"` interpolation. They are read as documentation but cannot be executed.

This pattern — design samples ahead of the compiler — is useful as a forcing function but dangerous as a default: users encounter samples that fail to build, and CI never catches regressions in them.

## Decision

**Rewrite the aspirational samples to today's parseable subset _now_.** Re-expand them as phases land. Specifically:

- Phase 0.2 rewrites `samples/Loop.gs` using only constructs that today's parser/binder/emitter all accept (`for i := lo ... hi` range form, no `i--`, no indexing, no `&`/`*` pointers, no `"{i}"` interpolation).
- Phase 0.3 audits `design/Gsharp-design-v0.1.md` and either rewrites its inline samples or annotates them as "aspirational; see v0.2 for current syntax."
- Every later phase's exit criteria include re-expanding `samples/` to exercise the features that phase shipped. E.g., Phase 1 re-introduces interpolation (`"$i"`); Phase 2 re-introduces `i--` and C-style `for`; Phase 3 re-introduces indexing.
- A `samples/aspirational/` folder MAY hold unparseable-but-pedagogical samples explicitly marked "future state." These are excluded from the conformance suite (ADR introduces this exclusion when the folder is created).

## Consequences

Positive:

- Every `samples/*.gs` builds and runs on every PR (enforced by the conformance suite, Phase 0.4).
- New users encounter only working samples by default.
- Each phase exit produces a visible, testable demonstration of the feature it shipped.

Negative:

- Loses some of the "look how nice this _will_ be" pedagogical value of the original Loop sample. Mitigation: the `aspirational/` folder preserves that mode for users who opt in.
- Requires a tiny bit of churn each phase (re-edit samples), but this is also the most direct check that the feature works end-to-end.

Neutral:

- The execution-plan exit criteria already encode this re-expansion cadence; ADR formalizes the policy.

## Alternatives considered

- **Acceptance-test mode** (freeze the aspirational samples; phase exit = they build): rejected; leaves users with broken samples for the duration of the bootstrap.
- **Both folders from day one** (`samples/` for parseable, `samples/aspirational/` for not): accepted as a future option, not a Phase-0 requirement. The aspirational folder is created only if there's actual demand.
