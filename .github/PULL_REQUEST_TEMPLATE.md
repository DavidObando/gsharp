<!-- Keep it short. Measured evidence (tables, counts, hashes) beats prose claims. -->

Fixes #<issue> <!-- or: Part of #<issue> -->

## Summary

- <what changed and why, imperative bullets>

## Verification

- <Release solution build result: warnings/errors>
- <test evidence: suites run with counts, or the targeted filter used and why; note anything NOT RUN and the reason>
- <for product changes: the witness — pre-fix RED / mutant killed, per ADR-0154>

## Checklist

- [ ] Behavioral tests carry a witness of discrimination (ADR-0154): each new/changed test fails on the pre-change code (pre-fix commit, reverted hunk, or an applied product mutant) and passes with it.
- [ ] Self-review verdict recorded when one was run (MERGEABLE / BLOCKER / SHOULD-FIX / NIT), with residuals filed as issues rather than dropped.

<!-- Delete this block unless the PR enables `#nullable` on new files. -->
### If this PR is a nullable slice (ADR-0155)

- [ ] Three commits, unsquashed: `nullable(directives)` (mechanical, reviewer skips), `nullable(annotate)` (the only commit a human reads), then zero or more `fix(#NNNN)` behaviour commits.
- [ ] `python3 build/nullable_hygiene.py` clean; the `!` report pasted into Verification.
- [ ] **Nullable widenings**: every new `?` on a public/internal signature listed with the call site that produces null. A `?` with no such call site is a widening — it forces every caller to handle a null that never occurs — and does not belong in the diff.
- [ ] **Null guards added**: the `guard-added` advisory from `nullable_hygiene.py` reviewed, and each listed guard confirmed unreachable from every caller or genuinely a no-op. A guard added to silence a nullable warning is a behaviour change (ADR-0155 A8).
- [ ] **Latent bugs surfaced**: listed with issue numbers, or explicitly "none". An empty section is a claim; a missing one is silence.
- [ ] `ArgumentNullException` guards: count reviewed, count removed (expected 0 — removal is a behaviour change needing its own commit and witness).
- [ ] Nullable changes preserve the production/test project boundary.
- [ ] `test/Core.Tests/Baselines/refactoring-baseline.json` unchanged, or the change is explained with a witness — an annotation-only PR cannot move it.
