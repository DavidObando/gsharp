# ADR-0154: Test oracle strength — the witness of discrimination

- **Status**: Accepted
- **Date**: 2026-08-03
- **Phase**: Test-suite integrity
- **Related**: #3163 (code-health P1 item 4); instances #3161, #3150, #3145, #3142, #3131, and the
  review threads on #3126 and #3128; ADR-0150 §Verification protocol (byte-compare precedent)

## Context

A recent audit found at least seven tests, across seven issues in one session, that assert an
observable symptom rather than the property they claim to verify. Each was green in both the
world where the claimed behavior holds and the world where it is broken. The recurring shape,
as #3161 put it: the test name states a semantic property, the assertion checks a coarser
observable that is constant across the property's two sides, and the test passes in both worlds.

These are not hypothetical weaknesses. In several cases the broken world was constructed and
measured — an exact revert of the fix, or a behavior-changing product mutant — and the full
suite stayed green. A test like that is worse than no test: it puts a reassuring name in the
suite over a property that nothing pins, so the next person to change that behavior sees green
and believes the property is covered.

The concrete anti-patterns, each observed in this codebase:

1. **Byte-identical fixture pair** (#3161). The positive and negative variants of the claimed
   property produce identical output — escaping vs. non-escaping receivers under `gsi` were
   byte-identical in stdout and diagnostic count — so the assertion cannot distinguish them.
   The test name claimed reachability semantics; the only load-bearing assertion was a
   diagnostic count about something else.
2. **Degenerate parity oracle** (#3150). A driver-parity test computed its oracle from an emit
   run in which the discriminating code (deinit bodies) never executed, so the "computed"
   oracle equaled a constant; deleting the deinit bodies left the test green. One row compared
   an object to itself (`result = emitted` followed by `Assert.Equal(emitted, result)`).
3. **Unpinned product change** (#3145). A binder fix (`Binder.cs:1600`) shipped with no test
   through its path: reverting the hunk left the entire suite green. Live product code pinned
   by no test is silently revertable, especially when the PR body never explained the line.
4. **Asserting the message, not the promise** (#3142). GS0159 suggests `?.` or `if let`; every
   test asserted the message string, none compiled the remedy. The suite pinned that the
   message is *printed*, not that it is *true* — a future change could break the remedy while
   every string comparison stays green.
5. **Vacuous quantifier** (#3131). `Assert.All` as the sole assertion passes trivially on an
   empty collection. Separately, the originating issue's own repro shape (inherited `deinit`,
   two GS0510) appeared in zero tests — the suite pinned only simpler shapes.
6. **Wrong-direction assertion** (#3126 review). A nullability corpus asserted widening
   assignments (`var x string? = …`), which succeed whether or not the binder preserves the
   annotation. The exact-revert mutant survived while a control mutant died — proving the
   corpus watched the site but was blind on the one axis it existed to protect. A census of
   specimens is not coverage of an axis.
7. **Matrix blind spot behind a green matrix** (#3128 review). A 14-case span matrix contained
   zero `char` and zero sliced cases; a length-vs-backing-array mutant survived it, and a
   silent wrong answer (internal type name printed at rc=0, diverging from the emit oracle)
   was invisible to a fully green suite. Related: driver cells simulated in-process in a
   configuration no real driver can create, where the real drivers demonstrably differ.

## Decision

Every behavioral test must carry a **witness of discrimination**: evidence, produced at least
once, that the test fails when the claimed property is violated. A test whose passing and
failing worlds are indistinguishable is decoration, not verification.

Acceptable witnesses, in this repo's workflow:

- **Pre-fix commit.** A regression test for a fix must demonstrably fail on the pre-fix
  commit (the fix-per-issue workflow makes this cheap: check out the base, run the test, RED;
  with the fix, GREEN). One-sided evidence is not evidence — a test that only goes green with
  the fix, or only red without it, has not been shown to discriminate.
- **Deliberately broken variant.** An exact revert of the product hunk, or a behavior-changing
  product mutant on it, asserted applied (diff plus artifact-hash movement), with the test
  going red. When the primary mutant survives, a control mutant that does die is required to
  distinguish a genuine survival from a no-result — a no-result is not a survival.
- **Discriminating fixture pair.** Parity and conformance tests must include at least one
  fixture pair whose two sides produce different observables under the assertion — if the
  positive and negative variants are byte-identical in everything the test reads, the pair
  pins nothing (anti-patterns 1 and 2).

Corollary rules, one per anti-pattern above:

- An all-driver conformance sample added as evidence for a fix must be verified to fail under
  a driver with the fix reverted (anti-patterns 2 and 3).
- A diagnostic that recommends an action needs a companion test that performs the action —
  derive the remedy from the message text so the two cannot drift (anti-pattern 4).
- `Assert.All` (or any universally quantified assertion) must be paired with a non-emptiness
  assertion (anti-pattern 5).
- Assert in the direction the property protects: a guard against illegal narrowing is
  witnessed by a rejected narrowing, never by an accepted widening (anti-pattern 6).
- A driver-matrix cell must be produced by the real driver invocation a user can run;
  in-process simulations that bypass the real binding path are labeled as such, not presented
  as driver columns (anti-pattern 7).
- A test name must not claim more than its assertions pin; when the honest fix is to rename,
  rename (anti-pattern 1).

The witness is recorded in the PR body (the existing Mutation/Verification sections already
carry exactly this shape of evidence), and the PR checklist carries a line item referencing
this ADR.

## Consequences

- Regression tests become falsifiable artifacts: each one is known to have been red at least
  once for the right reason, so a green suite is evidence rather than decoration.
- Writing a test gets slightly more expensive — one extra run against the base or a mutant.
  The fix-per-issue workflow already produces the pre-fix tree, so the common case costs one
  targeted test invocation, not a suite run.
- Reviews get a concrete question to ask — "what is the witness?" — instead of relying on
  taste to spot vacuous oracles. All seven instances above passed review before the audit.
- Existing tests are not retroactively invalidated; the rule applies to new and changed tests.
  The seven filed instances are tracked by their own issues.

## Future work (out of scope)

Periodic mutation testing (e.g. Stryker.NET) over Binding, Lowering, and Emit would measure
oracle strength mechanically instead of per-PR by hand, and would have caught anti-patterns
3, 6, and 7 without an audit. That is deliberately out of scope for this ADR — it is a CI
cost/infrastructure decision, tracked separately under #3163.

## Alternatives considered

- **Mandate mutation testing on every PR** — rejected: the suite takes 45+ minutes and a
  mutant run multiplies that; the manual witness costs one targeted run and covers the same
  question for the code actually changed.
- **Rely on review to catch weak oracles** — rejected by the evidence: every instance above
  merged through review. The failure mode is systematic (symptom vs. claim), so the
  countermeasure must be a checklist obligation, not vigilance.
- **Coverage thresholds** — rejected: coverage measures execution, not discrimination. Each of
  the seven tests executed the code it failed to pin.
