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
| `tree/.github/workflows/cs2gs-monitor-nightly.yml` | same | new; replaces `cs2gs-selfmig-nightly.yml` |
| `tree/.github/workflows/selfhost-stage2-nightly.yml` | same | new; hook for the ADR-0198 controller (does not edit it) |
| `cutover_edits.py` | n/a | exact-text edits: `build.yml` (drop the hot-core guard and its classifier, drop the hygiene step but keep the job and the version-reference steps, `.sln`/`.csproj` to `.slnx`/`.gsproj`), the other workflows, the CI-matrix scripts, `emit-pipeline.md`, `lsp.md`, `debug-info.md`, `compiler-architecture.md` |
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
2. Resolve the two `CUTOVER-VERIFY` markers (restore command with lock files;
   the GSA analyzer decision) or run with `--allow-markers` and resolve after.
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

- `nullable-hygiene` also runs the release-version-reference checks, so the job
  stays and only the script step goes.
- `publish` depends on `cs2gs-corpus`, `cs2gs-oahu`, `cs2gs-code-exploder` but
  not on the hot-core guard; removing the guard does not touch `publish`.
- The stage-2 contract test is added to `test-partition` by PR #4842; there is
  no stage-2 nightly yet (plan item C5), hence the hook with a loud failure
  while `STAGE2_ARGS` is empty.
- `selfhost-windows.yml` (migrated Core.Tests beside the C# suite) compares
  against a C# baseline; it is not edited here. Retire or re-scope it after the
  cut-over (owner decision below).

## Owner decisions needed

1. **GSA0001-GSA0003** (`src/Analyzers/InternalAnalyzers`): these are Roslyn
   analyzers over C# syntax and cannot gate `Core.gsproj`. Port them to G#
   analyzers (the framework exists; ADR-0193 phases 2-3 do this for
   GSA0007/8) or retire them as review conventions. The staged page says
   "convention" and carries the marker.
2. **D9 wording "stages 1 and 2"** for the C# version of G# in the nightly
   monitor: cs2gs pipeline stages (translate, compile) or the self-host stages?
   The staged monitor runs the whole cs2gs pipeline; narrow it if the first
   reading was meant.
3. **cs2gs-oahu / cs2gs-code-exploder**: today PR-time jobs that `publish`
   depends on. D9 says "nightly". The staged `build.yml` keeps them as PR jobs
   and adds nightly copies. Move them to nightly only, or keep both?
4. **`nullable-hygiene` job name**: kept to avoid changing the required check
   context. Rename (job and required context together) or keep?
5. **Lock files**: do translated `.gsproj` projects carry `packages.lock.json`?
   If not, `--locked-mode` has to go from every workflow and from
   CONTRIBUTING.md.
6. **`selfhost-windows.yml` and the stage-1 packer/compare scripts** in
   `test-partition` (`test-selfhost-pack-stage1.py`,
   `test-selfhost-compare-trx.py`): keep after the cut-over or retire?
7. **Source-root parameter for the cs2gs monitor**: `run-cs2gs-selfmig-*.sh`
   assume the checkout is the C# source. Adding `SELFMIG_SOURCE_ROOT` and
   `tools/cs2gs/external/gsharp-csharp.json` is Phase 4 implementation work,
   not done here. Until then the monitor's gsharp-csharp leg fails loudly.
8. **CI shard rebalancing**: band timings for the G# test projects are unknown
   until the first run; `generate-ci-test-matrix.py` only gets the mechanical
   renames now. Rebalance after the first full G# CI run.
