# cs2gs migration policy: what to do when a cs2gs gate is red

Applies to cs2gs as a product and to the gates that keep it honest: the
`cs2gs-corpus` PR job and the `cs2gs-apps-nightly` workflow (the C# version of
G#, Oahu and Code Exploder in one run). The C# to G# self-migration of this
repository ([#3501](https://github.com/DavidObando/gsharp/issues/3501)) is
complete: the compiler source on `main` is G#, and the translation guard that
this document used to govern (`cs2gs-pr-guard`, `hot-core translation guard`,
`cs2gs-selfmig-nightly`) is retired. How the cut-over was done is recorded in
[`self-migration-cutover.md`](self-migration-cutover.md) and
[`self-host-bootstrap.md`](self-host-bootstrap.md).

## Why cs2gs is still exercised

Three goals drove the migration and still drive cs2gs work. They are not
ranked; a change that serves one at the cost of another is usually the wrong
change:

1. **Move C# code to G#** readably, maintainably and correctly: output that is
   idiomatic G#, not merely output that compiles.
2. **Find and fix compiler defects.** Every construct Roslyn accepts is a test
   case gsc has to answer correctly. A defect found this way is worth more than
   the translation step it blocked, because it affects every G# user.
3. **Keep cs2gs at the quality bar G# adoption needs.**

Goal 2 is why a red cs2gs gate is good news rather than an obstacle: **the gate
found a real defect.**

## What the gates consume

- `tools/cs2gs/corpus`: C# programs with expected outputs.
- `tools/cs2gs/external/*.json`: pinned third-party apps (Oahu, Code Exploder).
- Branch `cs2gs/csharp-0.4` at a pinned SHA: the C# source of the G# compiler,
  kept as a large real-world corpus. The branch is semi-frozen: no bug fixes and
  no features, but code is back-ported from G# to C# when it merits exercising
  cs2gs. A back-port is a branch commit plus a pin bump on `main`.

## The rule

**A red `cs2gs-corpus` PR gate blocks the PR. It is never advisory.** The apps
nightly is not a PR gate. When an app goes red the nightly files (or updates)
one issue per gate, app and failure fingerprint, with the gate report. The
issue is P0 only when an app that was previously green on `main` goes red, and
P1 otherwise. The fix is to cs2gs or gsc, in G#.

## What to do, in order

1. **Fix the defect in cs2gs or gsc.** This is the default and it needs no
   approval. Classify it first: gsc defect, cs2gs translation defect, or a
   source shape not worth translating.
2. **Prefer the simplest possible G# for a given C# input.** If the natural
   translation is ugly, that is usually a defect report about cs2gs.
3. **No lossy translation.** The one deliberate exception is conditional
   compilation: cs2gs reports `#if`/`#elif` as an error. License headers are
   preserved; `#region`, `#pragma` and in-body blank lines are not.
4. **Never exclude a file or app from a gate to get green.** An exclusion says a
   project is not a target; it is never a way to dodge a defect.
5. **Never raise a ratchet ceiling to absorb a regression.** Ceilings move when
   a metric improves, in the same PR that improves it.

## When to stop and ask

- **Syntax design changes** (ADR-scale).
- **Breaking changes to the semantics of already-supported constructs.**

Adding G# language surface purely to accommodate the translator needs an ADR.
Everything else proceeds without asking.

## If a gate is red for an unrelated reason

Say so, with evidence and a link to the run, and do not merge past it silently.
"Unrelated" needs the same standard of proof as any other claim.

## Related

- `tools/cs2gs/README.md`: the translator.
- `tools/cs2gs/triage/gaps.json`: the gap ledger the corpus gate enforces.
- `tools/cs2gs/selfmig-test-allowlist.json` and
  `tools/cs2gs/selfmig-test-name-baseline.json`: the policy register and
  per-name baselines for translated test projects. An empty allow-list is its
  healthiest state.
