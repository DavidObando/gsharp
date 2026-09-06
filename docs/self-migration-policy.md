# Self-migration policy: what to do when the PR translation guard is red

Applies to the C# → G# self-migration effort ([#3501](https://github.com/DavidObando/gsharp/issues/3501)) and to
the `cs2gs-pr-guard` check (`build/run-cs2gs-selfmig-pr-guard.sh`).

## Why the migration exists

Three goals, and they are not ranked — a change that serves one at the cost of
another is usually the wrong change:

1. **Move the repository entirely to G#.**
2. **Find and fix as many compiler defects as possible.** The C# compiler is
   being used as a fuzzer of sorts: every construct Roslyn accepts becomes a
   test case gsc has to answer correctly. A defect found this way is worth more
   than the migration step it blocked, because it affects every G# user.
3. **Raise cs2gs to the quality bar G# needs for serious adoption** — readable,
   maintainable, correct output. Not merely output that compiles.

Goal 2 is why a red guard is good news rather than an obstacle: **the guard
found a real defect**, and the migration is the mechanism that surfaced it.

## The rule

**A red translation guard blocks the PR. It is never advisory.**

It is the only check that asks the self-hosting question. CI *compiles* the
repository's C# sources; the guard *translates* them and compiles the result.
Those are different questions, and a source file can answer the first perfectly
while failing the second — which is how a fully CI-green PR takes the nightly
gate down purely by existing, hours later, attributed to whatever else landed
nearby (#3831, #3896, #3905, #3915).

## What to do, in order

1. **Fix the defect in cs2gs or gsc.** This is the default and it needs no
   approval — proceed. A guard failure is a found bug, and finding bugs is the
   point (goal 2). Classify it first: gsc defect, cs2gs translation defect, or
   a source shape that is simply not worth translating.
2. **Prefer the simplest possible G# for a given C# input.** cs2gs should
   translate into ordinary, readable G# — not into clever G#, and not into a
   shape that merely satisfies the compiler. If the natural translation is
   ugly, that is usually a defect report about cs2gs, not a reason to accept
   the ugliness.
3. **Rewrite new C# into shapes G# already supports** when the construct has no
   G# equivalent and adding one is not justified on its own merits.
4. **Never exclude a file or app from migration to get green.** That converts a
   visible failure into an invisible one — the same trade the test-parity
   allow-list exists to prevent. An `--exclude` is a statement that a project
   is *not a migration target*, never a way to dodge a defect.
5. **Never raise a ratchet ceiling to absorb a regression.** Ceilings move when
   a metric improves, in the same PR that improves it. Lowering a floor or
   raising a ceiling to match a regression is how a gate stops meaning
   anything.

## When to stop and ask

Only two categories need sign-off before proceeding:

- **Syntax design changes** — new surface syntax, or a change to how an
  existing construct is spelled. These are ADR-scale decisions.
- **Breaking changes to the semantics of already-supported constructs.**
  Changing what existing, working G# code means is not a migration fix.

Adding G# language surface *purely to accommodate the translator* falls under
the first category. It is the tail wagging the dog unless independently
justified, and it deserves an ADR rather than a PR comment.

Everything else — fixing a binder bug, an emit bug, a translation infidelity,
a diagnostic that fires wrongly, a construct cs2gs mangles — proceeds without
asking.

## If the guard is red for an unrelated reason

Say so explicitly, with evidence and a link to the run, and do not merge past
it silently. "Unrelated" is a claim that needs the same standard of proof as
any other — infrastructure flakes and real regressions look identical from the
summary line.

## Related

- `build/run-cs2gs-selfmig-pr-guard.sh` — what the guard covers, and
  deliberately does not.
- `tools/cs2gs/selfmig-baseline.json` — the ratchet, and the discipline for
  moving its numbers.
- `tools/cs2gs/selfmig-test-allowlist.json` — the policy register for tests
  whose premise stops holding after migration. An empty list is its healthiest
  state.
- ADR-0115 §B — the canonical G# output contract cs2gs must satisfy.
- ADR-0179 — `gsfmt`, which takes over layout decisions from the printer.
