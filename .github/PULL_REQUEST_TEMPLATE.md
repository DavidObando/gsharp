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
