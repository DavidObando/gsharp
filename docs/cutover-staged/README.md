# Cut-over staging area

Everything the repository needs the moment `main` becomes G#, prepared ahead of
time so nothing on `main` changes today. Plan: #3501 (comment of 2026-10-01 and
the update of 2026-10-02), cut-over criterion 10 and Phase 4. **Delete this
directory when the content has been applied.**

This directory is not read by the website build (Docusaurus only reads
`website/docs`), by `pages.yml`, or by any CI job. The release-version check
(`build/check-release-version-refs.py`) does scan it, so the staged text uses
`0.4.NNNN` and never a package-qualified version pin.

## Contents and destinations

| Staged file | Destination | How |
|---|---|---|
| `tree/CLAUDE.md` | `CLAUDE.md` | replaced |
| `tree/CONTRIBUTING.md` | `CONTRIBUTING.md` | replaced |
| `tree/docs/self-migration-policy.md` | `docs/self-migration-policy.md` | replaced; re-scoped to the cs2gs product and gates (the old fixture-provenance section is in git history) |
| `tree/docs/internal-analyzers.md` | `docs/internal-analyzers.md` | replaced; contains a decision marker |
| `tree/.github/workflows/cs2gs-apps-nightly.yml` | same | new; replaces `cs2gs-selfmig-nightly.yml`; one run over the C# version of G#, Oahu and Code Exploder, with a `gate` job that files or updates issues |
| `tree/build/cs2gs-apps-gate-issues.py`, `tree/build/test-cs2gs-apps-gate-issues.py` | same | new; issue filing (dedup by gate/app/fingerprint; P0 only for a banked app red on main, else P1) and its test |
| `tree/.github/workflows/selfhost-stage2-nightly.yml` | same | new; hook for the ADR-0198 controller (does not edit it) |
| `cutover_edits.py` | n/a | exact-text edits: `build.yml` (drop the hot-core guard and its classifier, scope the hygiene step to the remaining C# (all checks but `coverage`; the job and the version-reference steps stay), retarget `build/run-ilverify.sh` and `e2etests/*.sh` to `.slnx`/`.gsproj` for product projects only (fixture and host projects they generate stay C#), park `selfhost-windows.yml` (dispatch-only), remove the `cs2gs-oahu` and `cs2gs-code-exploder` jobs and their `publish` dependency, `.sln`/`.csproj` to `.slnx`/`.gsproj`), the other workflows, the CI-matrix scripts, `emit-pipeline.md`, `lsp.md`, `debug-info.md`, `compiler-architecture.md` |
| `apply.sh` | n/a | runs the above, deletes `cs2gs-selfmig-nightly.yml` and the PR-guard scripts, reports doc paths that no longer exist |
| `TRIAGE-CHECKLIST.md` | n/a | owner's `gh` commands for Phase 4 item 6 and the repository settings |

Release notes: the text is `docs/release/release-notes-0.5-draft.md` (updated in
place in this PR for decisions D2, D4, D7, D11). At the cut-over, copy its
`0.5.x` section into `website/docs/release-notes.md` under Unreleased and remove
the draft banner. The website compiler-architecture page edit is in
`cutover_edits.py`.

## Apply order (cut-over PR, Phase 3)

1. Translate at the tag commit and apply the plan's hand-fix list. Additions:
   `src/vs-gsharp` is **not** translated (owner decision, 2026-10-09). It stays
   C# with its `#if NETFRAMEWORK` directives; exclude it from the cs2gs run,
   keep its `.csproj`/`VsGsharp.sln`, and make sure its reference to the
   migrated language server resolves (`VsGsharp.csproj:76` points at the
   LanguageServer project, which becomes a `.gsproj`). It builds on Windows only
   (`visual-studio-extension` job, `windows-latest`); the apply script leaves
   those workflow lines unchanged.
2. Resolve the `CUTOVER-VERIFY` marker (restore command and lock files, see
   decision 5) or run with `--allow-markers` and resolve after.
3. `docs/cutover-staged/apply.sh --check`, then `docs/cutover-staged/apply.sh`.
   It refuses to run unless `src/Core/Core.gsproj` exists and no `Core.csproj`.
4. Review the git diff, fix the listed doc paths, and do the manual steps the
   script prints.
5. Validate on the PR: full `build.yml`, e2etests, both VSIXs.

Dry run done in this PR on a copy of the current tree: all edits apply, every
workflow file still parses as YAML, and a second run fails loudly instead of
double-applying. The doc-path report on the C# tree lists the `.gs` paths as
missing, which is expected before the translation.

## Verified facts the staged content relies on

- `nullable-hygiene` also runs the release-version-reference checks, and
  `src/vs-gsharp` (C#, nullable enabled) still needs the hygiene script, so the
  job stays and the script runs with every check except `coverage` (which
  asserts src/Core's C# shape).
- `publish` depends on `cs2gs-corpus`, `cs2gs-oahu`, `cs2gs-code-exploder` but
  not on the hot-core guard. The staged edit drops the last two from `needs`
  together with their jobs.
- The stage-2 contract test is added to `test-partition` by PR #4842; there is
  no stage-2 nightly yet (plan item C5), hence the hook with a loud failure
  while `STAGE2_ARGS` is empty.
- `selfhost-windows.yml` (migrated Core.Tests beside the C# suite) compares
  against a C# baseline; it is parked, not edited beyond path renames.

## Owner decisions (answered 2026-10-09) and what remains

1. **GSA0001-GSA0003: retired at the cut-over**, replaced by the G#
   GSA0007/GSA0008 analyzers (ADR-0193 phases 2-3). **Enforcement gap:** those
   analyzers enforce the nullability funnel, not the three retired rules. Until
   someone writes G# equivalents, struct-field-token reads (GSA0001), imported
   CLR `Type` reference comparisons (GSA0002) and strong static reflection
   caches (GSA0003) are caught only in review. `docs/internal-analyzers.md`
   states this. If one of those bug classes recurs, port that rule.
2. **What the apps nightly tests, and the C# branch policy.** The tool under
   test is cs2gs built from the checked-out `main` tree (G# source, pinned
   toolchain). Its inputs are C# programs: `cs2gs/csharp-0.4` at a pinned SHA
   (the `gsharp-csharp` leg, passed as `SELFMIG_SOURCE_ROOT`; its translated
   output is the G# compiler tree, which is compiled, ILVerified and
   parity-tested), Oahu and Code Exploder. The branch is semi-frozen: no fixes
   or features, but code is back-ported from G# to C# when it merits
   exercising cs2gs. There are no "stages" in this nightly; self-host stage 2
   is the separate `selfhost-stage2-nightly`.
3. **Oahu and Code Exploder moved out of PR and official builds** into
   `cs2gs-apps-nightly` (build.yml jobs and the `publish` dependency removed by
   `cutover_edits.py`). All three apps are legs of one run; the `gate` job
   merges their results into the run summary and files or updates one issue per
   gate/app/fingerprint (`issues: write`).
4. **`nullable-hygiene` keeps its name** (rename later with its required check
   in one settings change).
5. **Lock files:** `--locked-mode` stays. The cut-over dry run confirms whether
   translated `.gsproj` files carry `packages.lock.json`; if not, the cut-over
   commits them. The marker in `CONTRIBUTING.md` stays until then.
6. **`selfhost-windows.yml` is parked** (kept, not gating; the apply script makes it
   dispatch-only; it is not rewritten to .gsproj, and still needs repair against `cs2gs/csharp-0.4` before it can run). The stage-1 pack and TRX-compare contract checks
   in `test-partition` are retired once the #4842 controller is live: delete the
   steps `Verify self-host stage-1 packer contract` and `Verify the self-host
   TRX comparison` (and their `build/test-selfhost-*.py` scripts) in a follow-up
   after #4842 merges. They are not removed by `apply.sh`, because #4842 edits
   the same job.

Still open or not done:

- **Setup for the apps nightly:** `tools/cs2gs/external/gsharp-csharp.json`,
  `tools/cs2gs/apps-nightly-banked.json` (an app is banked only after it has
  been seen green on main), the `cs2gs-nightly` label, and the
  `SELFMIG_SOURCE_ROOT` parameter in `build/selfmig-common.sh` (the
  `run-cs2gs-selfmig-*.sh` scripts assume the checkout is the C# source). The
  gsharp-csharp leg fails loudly until the parameter exists. Folding the old
  gate's per-app accounting (stage floors, readability counters) into each
  leg's `result-<app>.json` summary is also Phase 4 work.
- **Required checks:** `cs2gs-oahu` and `cs2gs-code-exploder` disappear from
  PR runs; if either is a required status check, remove it
  (`TRIAGE-CHECKLIST.md`, section 3).
- **CI shard rebalancing:** band timings for the G# test projects are unknown
  until the first run. `generate-ci-test-matrix.py` only gets the mechanical
  renames now.
