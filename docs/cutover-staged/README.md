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
| `tree/docs/internal-analyzers.md` | `docs/internal-analyzers.md` | replaced (retired rules, enforcement gap stated) |
| `tree/.github/workflows/cs2gs-apps-nightly.yml` | same | new; replaces `cs2gs-selfmig-nightly.yml`; one run over the C# version of G#, Oahu and Code Exploder, with a `gate` job that files or updates issues |
| `tree/build/cs2gs-apps-gate-issues.py`, `tree/build/test-cs2gs-apps-gate-issues.py` | same | new; issue filing (dedup by gate/app/fingerprint; P0 only for a banked app red on main, else P1) and its test |
| `tree/.github/workflows/selfhost-stage2-nightly.yml` | same | new; hook for the ADR-0198 controller (does not edit it) |
| `cutover_edits.py` | n/a | exact-text edits: `build.yml` (drop the hot-core guard and its classifier, scope the hygiene step to the remaining C# (all checks but `coverage`; the job and the version-reference steps stay), retarget `build/run-ilverify.sh` and `e2etests/*.sh` to `.slnx`/`.gsproj` for product projects only (fixture and host projects they generate stay C#), park `selfhost-windows.yml` (dispatch-only), remove the `cs2gs-oahu` and `cs2gs-code-exploder` jobs and their `publish` dependency, `.sln`/`.csproj` to `.slnx`/`.gsproj`), the other workflows, the CI-matrix scripts (`.csproj` to `.gsproj`; `Gsharp.Extensions.csproj` stays, it is excluded from the migration), `emit-pipeline.md`, `lsp.md`, `debug-info.md`, `compiler-architecture.md` |
| `apply.sh` | n/a | runs the above (`GSharp.sln` becomes `GSharp.slnx` through the same pattern as `build/cutover.py` hand-fix 4b, so a tree that hand-fix already renamed is not renamed twice), deletes `cs2gs-selfmig-nightly.yml` and the PR-guard scripts, audits all Markdown (except ADRs, which are historical records and keep their old links) for broken links, missing paths and mentions of removed workflows/scripts, e.g. `tools/cs2gs/README.md`; report only, fix by hand |
| `TRIAGE-CHECKLIST.md` | n/a | owner's `gh` commands for Phase 4 item 6 and the repository settings |

`docs/self-migration-cutover.md` already exists on `main` (PR #4855: procedure,
mapping rules, hand-fix audit, dry-run log). It is **not** replaced. The cut-over
PR fills in its "Recording the translation" table and appends the final dry run.
Source files are not rewritten for the solution rename: repository-root discovery
goes through `RepositoryRootMarker`, which accepts `GSharp.slnx` or `GSharp.sln`
(#4864), and `build/cutover.py` hand-fix 4b renames the `GSharp.sln` command name
only in scripts, workflows and build files, never in `.cs`/`.gs`.

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
2. Run `build/cutover.py hand-fix` first (`docs/self-migration-cutover.md`); `apply.sh`
   assumes its result (`.gsproj` twins, `GSharp.slnx`, regenerated lock files). No
   `CUTOVER-VERIFY` marker is left in the staged files (the lock-file question was
   answered by the dry run); `--allow-markers` remains for markers added later.
3. `docs/cutover-staged/apply.sh --final-version 0.4.NNNN --check` (use the real final release number), then the same without `--check`.
   It refuses to run unless `src/Core/Core.gsproj` exists and no `Core.csproj`.
4. Review the git diff, fix the listed doc paths, and do the manual steps the
   script prints.
5. Validate on the PR: full `build.yml`, e2etests, both VSIXs.

Dry run done in this PR on a copy of the current tree (re-done 2026-10-12 on
`main` at `d4943a122`, after running the 4b rename first and giving the copy
`.gsproj` twins): all edits apply, every workflow file still parses as YAML, no
`GSharp.slnxx`, `Gsharp.Extensions.csproj` untouched, and a second run fails loudly
instead of double-applying. The doc-path report on the C# tree lists the `.gs` paths as
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

## What the nightly runs after the cut-over

The cs2gs nightly (`cs2gs-apps-nightly`) runs the **cs2gs built from `main`**
(written in G#, pinned toolchain) against **C# source**: the semi-frozen branch
`cs2gs/csharp-0.4` at a pinned SHA (the branch may receive occasional C#
backports from G# when they are worth extending cs2gs coverage), plus Oahu and
Code Exploder. Nothing on `main` is translated by it. Oahu and Code Exploder
are **moved out of PR and official builds** into this nightly (job renamed from
`cs2gs-oahu` / `cs2gs-code-exploder` to legs of `cs2gs-apps-nightly`), and their
accounting is part of the end-of-run stats. **A failed gate opens a GitHub
issue** carrying the gate report. The Visual Studio extension (`src/vs-gsharp`)
stays C# with `#if NETFRAMEWORK` and is not migrated.

## Facts that depend on PRs not yet merged

Verified 2026-10-12 against `main` at `d4943a122`:

- #4864 (repo root marker), #4855 (dry-run script and doc), #4866
  (`cs2gs migrate --stop-after <stage>`), #4871 and #4875 (ADR-0199 record ABI)
  are merged. This directory is consistent with them.
- **#4865 (mirror copies referenced `.cs` files verbatim; ildump untracked) is
  still open.** Once it lands the corpus is **56 apps with greenFloor 56**
  (`main` still says 57), `EXPECTED_RETAINED_CSHARP` in `build/cutover.py` is
  empty, and the retained-C# note in `docs/self-migration-cutover.md` changes.
  Nothing staged here hard-codes a count; the setup list below says 56 only for
  the numbers the `gsharp-csharp` leg's accounting must carry over.
- **#4842 (stage-2 controller) is still open.** `build/selfhost-stage2.py` does
  not exist yet; `cutover_edits.py` prints a note and has no edit for it (the
  controller names `Gsharp.Extensions.csproj`, which stays a `.csproj`).

## Owner decisions (answered 2026-10-09) and what remains

1. **GSA0001-GSA0003: retired at the cut-over** (GSA0004-GSA0007 stay).
   **Enforcement gap:** the ADR-0193 funnel analyzers (GSA0007 live, GSA0008 not
   yet) enforce the nullability funnel, not the three retired rules. Until
   someone writes G# equivalents, struct-field-token reads (GSA0001), imported
   CLR `Type` reference comparisons (GSA0002) and strong static reflection
   caches (GSA0003) are caught only in review. `docs/internal-analyzers.md`
   states this. If one of those bug classes recurs, port that rule. **The
   retirement is a manual step in the cut-over PR**, not done by `apply.sh`: the
   migration keeps the translated analyzer reference in `src/Core`, so delete only
   the three rules, their descriptors and tests by hand. Keep the project, the
   reference and GSA0004-GSA0007 (GSA0007, the ADR-0193 producer funnel, is live);
   GSA0008 is not implemented yet.
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
   merges their results (accounting included, Oahu and Code Exploder too) into
   the run summary and files or updates one issue per gate/app/fingerprint
   (`issues: write`), so a failed gate opens an issue with the gate report.
4. **`nullable-hygiene` keeps its name** (rename later with its required check
   in one settings change).
5. **Lock files:** `--locked-mode` stays. The dry run answered it: the 35
   translated product projects carry a `packages.lock.json` copied from the C#
   project, stale for the `.gsproj`; `cutover.py` hand-fix 8 regenerates them
   and the cut-over commits the result. The staged `CONTRIBUTING.md` says so.
6. **`selfhost-windows.yml` is parked** (kept, not gating; the apply script makes it
   dispatch-only; it is not rewritten to .gsproj, and still needs repair against `cs2gs/csharp-0.4` before it can run). The stage-1 pack and TRX-compare contract checks
   in `test-partition` are retired once the #4842 controller is live: delete the
   steps `Verify self-host stage-1 packer contract` and `Verify the self-host
   TRX comparison` (and their `build/test-selfhost-*.py` scripts) in a follow-up
   after #4842 merges. They are not removed by `apply.sh`, because #4842 edits
   the same job.

Owner task list (nothing below is done by this PR or by `apply.sh`):

- [ ] Create `tools/cs2gs/external/gsharp-csharp.json` (`{"commit": "<sha on
      cs2gs/csharp-0.4>"}`, the pin the nightly checks out) and
      `tools/cs2gs/apps-nightly-banked.json` (`{"banked": [...]}`; an app is added
      only after it has been seen green on `main`).
- [ ] Add the `SELFMIG_SOURCE_ROOT` parameter to `build/selfmig-common.sh` (the
      `run-cs2gs-selfmig-*.sh` scripts assume the checkout is the C# source). The
      `gsharp-csharp` leg fails loudly until it exists.
- [ ] Create the `cs2gs-nightly` label.
- [ ] Move the `gsharp-csharp` leg onto the sharded self-migration pipeline (the
      migrate job plus validate shards the old `cs2gs-selfmig-nightly` uses),
      parameterized by `SELFMIG_SOURCE_ROOT`. The staged leg calls the classic
      single-job `run-cs2gs-selfmig.sh`, whose full run (migration alone took
      4.5 hours on a hosted runner, per #4842) does not fit a hosted job; the
      leg's 360 minute cap is the hosted maximum, not evidence that it fits.
- [ ] Fold the old gate's per-app accounting (stage floors, readability counters)
      into each leg's `result-<app>.json` `stats`, for all three apps. Carry
      greenFloor 56 / 56 apps once #4865 lands.
- [ ] If `cs2gs-oahu` or `cs2gs-code-exploder` is a required status check, remove
      it from branch protection (`TRIAGE-CHECKLIST.md`, section 3). They disappear
      from PR runs.
- [ ] Rebalance the CI shards in `build/generate-ci-test-matrix.py` after the
      first G# CI run (band timings for the G# test projects are unknown until
      then; only mechanical renames are staged). Run `build/verify-ci-test-partition.py`.
- [ ] Retire the stage-1 pack and TRX-compare contract checks after #4842
      (stage-2 certification) lands: delete the steps `Verify self-host stage-1
      packer contract` and `Verify the self-host TRX comparison` and their
      `build/test-selfhost-*.py` scripts from `test-partition`. `apply.sh` does not
      remove them because #4842 edits the same job.
- [ ] Wire `STAGE2_ARGS` in `selfhost-stage2-nightly.yml` once #4842 has landed, and
      provide the self-hosted runner it targets (the controller trusts one pinned
      .NET layout and the run takes about eight hours, so a hosted runner cannot
      certify; #4885). Align the label with #4842's `selfhost-stage2.yml`. The
      `publish` job requires a successful run of this workflow on the tagged commit,
      so an unprovisioned runner blocks releases.

## Phase 4: documents that still say `GSharp.sln`

Contributor-facing documents still say `dotnet build GSharp.sln` (and `.csproj`
paths). Checked 2026-10-12 with `grep -rl 'GSharp\.sln\b' --include=*.md`:

| Document | Owner of the fix |
|---|---|
| `CONTRIBUTING.md` | replaced by the staged version (apply script) |
| `CLAUDE.md` | replaced by the staged version (apply script) |
| `tools/cs2gs/README.md` | `cutover_edits.py` (the one build command); the rest by hand |
| `README.md` (repository root) | no `GSharp.sln` today; re-check its build and test instructions for `.csproj` paths |
| `website/docs/getting-started/install.md` | hand, post-cut-over pass |
| `src/Sdk/Gsharp.NET.Sdk.Bootstrap/README.md`, `tools/cs2gs/corpus/README.md` | hand, post-cut-over pass |
| `docs/self-migration-4198.md` | historical; add a pointer or leave as a record |

`docs/self-migration-cutover.md` and `website/docs/release-notes.md` mention
`GSharp.sln` historically and stay. This PR does not change the documents marked
"hand": they are correct for the C# tree today. They are listed in the PR's
Phase 4 checklist. The apply script's audit also reports broken links and missing
paths for them.
