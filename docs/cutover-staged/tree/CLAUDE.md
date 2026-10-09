# Working in this repository (for Claude Code and other agents)

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. It covers building, testing,
discriminating tests (ADR-0154), design changes needing an ADR, and PR
hygiene. This file adds operational knowledge that has repeatedly cost time
when it was missing. When a rule here conflicts with a maintainer's explicit
instruction, follow the maintainer.

## The compiler is written in G#

Since 0.5 the compiler, the language server, the formatter and the tools in
this repository are G# source (`.gs`, `.gsproj`). They were translated from C#
by cs2gs at the final C#-built release (`v0.4.NNNN`); see
[`docs/self-migration-cutover.md`](docs/self-migration-cutover.md) for the
translation command and the path mapping. Three rules follow from that.

- **Fixes happen in G#, on `main`.** Do not edit the C# branch
  `cs2gs/csharp-0.4` to fix a bug. That branch is frozen: it holds the final C#
  source and is the pinned C# corpus for cs2gs. The only changes allowed there
  are (a) back-ports that cs2gs tests need, and (b) a security fix that must be
  released as `0.4.NNNN+k`. Both need the maintainer's say-so. A fix found while
  working on cs2gs is a fix in G#, or in cs2gs (which is also G#).
- **The N-1 rule: the repository builds with the previous released compiler.**
  The pin is `msbuild-sdks` in [`global.json`](global.json). The compiler's own
  source may use only language features that the pinned release supports. A PR
  that adds a language feature must not use that feature in repository source
  (including tests, samples and `src/`) until a release containing it becomes the
  pin. Bumping the pin is its own PR: bump `global.json`, rebuild from a clean
  clone, and confirm the stage-2 check still passes.
- **`src/vs-gsharp` (the Visual Studio extension) stays C#.** It is not a
  migration target and keeps its `#if NETFRAMEWORK` directives. It builds on
  Windows only and references the G# language server; don't translate it, and
  don't treat a C# file there as a missed migration.
- **Do not hand-edit pinned state to get green.** Never change the pin to a
  locally built or unreleased SDK in a PR, and never exclude a file to dodge a
  gsc defect. A gsc defect found while building the repository is a bug to fix
  (see "Bootstrap hazards" below), not a reason to rewrite the source around it
  unless the maintainer agrees.

## Pull requests and review

- **Copilot reviews every push automatically.** Never request it, and never
  write `@copilot` anywhere (commits, PR bodies, comments). That mention
  summons a coding agent that pushes to the branch. Refer to it as "Copilot".
- **After every push, check the new review before calling the PR done.**
  - Confirm the review is on the current head. A review summary can belong to
    an older commit even when it appears after your push.
  - Fix what's real. Reply on each thread saying what changed and in which
    commit, then resolve it. If a finding is wrong, reply with the evidence
    rather than ignoring it.
  - Read the summary's "Open" and "Previously missed" sections too. They can
    hold real findings that have no inline thread.
- **`mergeStateStatus: CLEAN` ignores review threads.** Before merging, count
  unresolved threads across every page (replace `N`):
  ```sh
  gh api graphql --paginate -f query='query($endCursor: String) {
    repository(owner: "DavidObando", name: "gsharp") { pullRequest(number: N) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes { isResolved } pageInfo { hasNextPage endCursor } } } } }' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | 1' | wc -l
  ```
- **When review rounds keep finding the same class of bug in new shapes,
  stop patching shapes.** Find the single place the decision is made and fix
  it there, or add a fail-safe default. Long PRs have burned many rounds on
  shape-by-shape fixes.
- **Decide landing criteria when a PR runs long.** Block on anything that
  makes output wrong: an unsound or wrong assertion, double evaluation, or a
  runtime behavior change. File coverage gaps that fail loudly (a compile
  error a gate would catch) as follow-ups in the relevant tracking issue.
- **Commits and PR bodies carry no attribution or co-author lines.**
- **`gh pr edit --body-file` fails silently** (a stale Projects-classic
  GraphQL error). Use
  `gh api repos/DavidObando/gsharp/pulls/N -X PATCH -F body=@file`.
- **Release notes** live in `website/docs/release-notes.md` under
  Unreleased. Concurrent PRs all touch it:
  - after every rebase, re-read the whole file rather than just the conflict
    hunks;
  - resolve conflicts by keeping every bullet.
- **Out-of-scope findings become issues.** If a fix exposes an unrelated
  bug or a needed architectural change, file it (`gh issue create --label bug`)
  and link it from the PR instead of widening the PR or dropping it.

## CI gates and known behaviour

The self-migration gates (the nightly self-migration and the hot-core
translation guard) are retired: there is no C# compiler source left on `main`
to translate. What gates a PR now:

- **`build`** builds the whole solution with the pinned SDK. This is also the
  smoke test that the pinned compiler can still compile `src/Core`.
- **`tests`** shards, one per test project (the big ones split by test-name
  band). `test-partition` proves every test runs exactly once. Rebalancing is a
  change to `build/generate-ci-test-matrix.py`; the verifier says whether the
  result is still a partition.
- **gsfmt check** (`gsfmt --check .`) fails on any `.gs` file that is not in
  canonical form. Fix it with
  `dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --write .`.
- **`ilverify`, `e2e`, the two VSIX jobs** are unchanged in purpose.
- **Stage-2 certification** (ADR-0198, `build/selfhost-stage2.py`) proves that
  the compiler built by the pinned compiler (stage 1) and the same source
  rebuilt by that stage-1 compiler (stage 2) emit identical `GSharp.Core.dll`
  and `gsc.dll` (except the validated `Module.Mvid` slot), and that the Core
  and Compiler test suites pass under stage 2. A stage-2 failure is a compiler
  defect only visible when gsc compiles itself: treat it as P0, stop and
  diagnose; do not re-run until green. It runs nightly (`selfhost-stage2-nightly`)
  and in the PR checks that ADR-0198 defines.
- **cs2gs gates** (`cs2gs-corpus`, `cs2gs-oahu`, `cs2gs-code-exploder`) still
  guard cs2gs as a product. They consume C# inputs that are not this
  repository's compiler source: the corpus under `tools/cs2gs/corpus`, and the
  pinned Oahu and Code Exploder commits under `tools/cs2gs/external/`.
- **cs2gs nightly monitor** (`cs2gs-monitor-nightly`) migrates the C# version
  of G# (branch `cs2gs/csharp-0.4`, at a pinned SHA), Oahu and Code Exploder
  every night. It is a regression monitor for cs2gs, not a gate on G# changes.
  A red monitor means cs2gs regressed on real-world C#; fix cs2gs.
- **`nullable-hygiene`** no longer runs `build/nullable_hygiene.py`. The job
  keeps its name because it also runs the release-version-reference check
  (`build/check-release-version-refs.py`). C#'s `!` is G#'s `!!`; see
  "Nullability architecture".
- **`Issue3347RemainingSpillInventoryTests`** counts retired synthesized names
  (`__spill`, `__cast`, `__decon`, `__using`) in the committed `.gs` tree.
  If it fails, a new `.gs` file contains one: write the code without it. Don't
  weaken the test.
- **Windows and differential-conformance nightlies** may be red. Shipping with a
  red nightly is a maintainer judgment call; don't assume a red Windows
  nightly is yours, and don't assume it isn't. Show the evidence.
- **Build docs** (`pages.yml`): the WebKit dark-theme accessibility check on
  `project/quality-dashboard` fails intermittently. When a PR doesn't touch
  that page, rerun it with `gh run rerun <run-id> --failed`.
- **cs2gs-oahu** migrates Oahu at the commit pinned in
  `tools/cs2gs/external/oahu.json`.
  `JobSchedulerTests.Bounded_Concurrency_Limit_Is_Enforced` is a known flaky
  test (DavidObando/Oahu#71). Show that a failure isn't yours before
  rerunning.
- **Flaky or not, check the logs first.** Pull the job log
  (`gh api repos/DavidObando/gsharp/actions/jobs/<id>/logs`) and show that
  the failure is unrelated, e.g. the same failure on `main` or on an
  unrelated PR, before rerunning.

## Bootstrap hazards

The compiler builds itself, so a gsc defect can break the build of gsc.

- **A change to the compiler is compiled by the pinned (older) compiler.**
  Your change is exercised by the pin first and by itself only in stage 2.
  A bug that miscompiles gsc's own source shows up as a stage-2 mismatch or as
  a crash in a test that is green under stage 1. Run the stage-2 check locally
  for changes to binding, lowering, emit or the runtime libraries
  (`build/selfhost-stage2.py`; see `docs/self-host-bootstrap.md`).
- **Determinism matters.** Emit must be byte-for-byte reproducible. Do not
  iterate a hash-ordered collection to assign numbers, names or table order.
  (#4663 was exactly this.)
- **Do not break the pin.** If a fix to gsc is needed to build the repository
  at all, land the gsc fix in a PR that builds with the current pin first (it
  must not use the fix), then use it in a later PR after the pin moves.

## Local environment

- **Test scope:** run targeted `--filter` test runs locally. Full suites run
  on PR CI. Build with `dotnet build GSharp.slnx --configuration Release -graph`;
  test projects are `*.gsproj`.
- **`/tmp` is a shared tmpfs of about 31 GB.** Stage-2 and cs2gs monitor runs
  fill it quickly, and when it fills every Bash command fails silently for
  everyone on the machine. Put their work roots (`--work`, `--out`,
  `--artifacts`, `TMPDIR`) under `~/.cache/<tag>/`, and delete them when
  you're done.
- **Keep durable state off tmpfs.** `/tmp` is RAM-backed and is wiped on
  reboot, and the session scratchpad (`/tmp/claude-*`) goes with it. Anything
  you'd need after a crash or reboot lives on disk, e.g. `~/.cache/<tag>/`:
  coordinator state and continuity logs, hand-off notes, drafted PR replies.
- **After a crash or reboot,** background processes, monitors and local runs
  are gone. Check each worktree's `git status` and clean interrupted work
  roots before resuming.
- **Never kill test processes by pattern.** `pkill -f "dotnet test"` (or
  `testhost`) matches your own shell and kills it. Kill by PID.
- **Long commands:** start them once in the background and wait for the
  completion notification. Don't poll with repeated `echo`/`sleep` calls.
- **Don't revert experiments with `git checkout -- <file>`** when the file
  also holds real fixes. Revert the experiment by hand.
- **The git stash is shared across worktrees.** Prefer a temporary WIP
  commit. If you must stash, tag the entry and `apply` it by SHA.
- **Commit messages:** when a sandbox refuses heredocs, write the message to
  a file and run `git commit -F <file>`.

## Nullability architecture

Nullability is where most recurring defects in this codebase have come from.
The compiler is now G# source, and the type and member names below are the same
names in `.gs` files. Before touching it, read:

- **ADR-0186** (platform types, `T!`): oblivious CLR positions are
  `PlatformTypeSymbol`, which is distinct from `NullableTypeSymbol` (`T?`).
  `--nullability=platform-types` is the default. The legacy `enabled` mode is
  being retired (#4372), so don't add new code paths that support it.
- **ADR-0193 (Proposed; phased rollout tracked in #4363):** nullability
  queries go through one funnel. Check what has landed before relying on it:
  - **Today:** don't add a new, independent computation of "is this
    nullable". That has been the single most frequent root cause of bugs.
    Reuse the existing readers (`ClrNullability.Get*TypeSymbol`, the
    receiver-aware `MemberLookup.GetClr*TypeSymbol` family) instead of calling
    `TypeSymbol.FromClrType` or `MapOpenClrTypeToSymbolic` on a signature
    position directly.
  - **Phase 1:** adds `NullabilityImportRule`, the single place that decides
    how an imported position's nullability maps to a G# type, plus the first
    `TypeSymbol` query members. From then on, route new decisions through it.
  - **Phases 2-3:** add the rest of the query API, and the analyzers that
    enforce the funnel (GSA0007/GSA0008, now written as G# analyzers; GSA0009
    for cs2gs is Phase 5). After they land, consumers use the query API
    instead of writing their own `is NullableTypeSymbol` tests. Until then,
    review for the pattern by hand.
- **Settled decisions** (don't reopen them without the maintainer):
  - `[Nullable(2)]` on an open type-parameter slot: a reference-type argument
    gives `T?`; a value-type argument is left unchanged, with no wrapping
    (`Min<int>()` returns `int`).
  - An in-scope unconstrained type parameter is left unchanged. Revisiting it
    as `T!` is tracked in #4385, after ADR-0193 Phase 3.
- **`!!` is a runtime check, not an annotation.** In G# source, `x!!` throws at
  the site when `x` is null. Use it where the value really cannot be null and
  failing fast is the right behaviour. Where a value can be null, restructure
  (`?.`, a guard, a nullable-aware signature) instead of asserting. A `!!` the
  compiler can prove redundant is reported as GS0536; remove it. Most `!!` in
  the translated source came from C#'s `!`; trimming them is ongoing cleanup,
  so don't treat a nearby `!!` as a pattern to copy.
- **Stated-nullable member chains need `!!` or `?.`.** gsc has no carve-out for
  these (#4356). `?.` changes the result type (`T` to `T?`), so it isn't a
  drop-in replacement for an unconditional dereference; `!!` is.

## Issue triage

Every open issue carries exactly one of `P0`, `P1` or `P2`:

- **P0:** actively breaking something. Examples: a red gate on `main`, a
  merge-blocking regression, a stage-2 mismatch, a process crash or silent
  miscompile reachable in default mode, a security issue. Keep these rare.
- **P1:** a confirmed bug with concrete impact and a repro. This includes
  invalid IL or ILVerify failures, internal compiler errors (GS9998) on valid
  code, and cs2gs dropping semantics without a diagnostic.
- **P2:** minor, cosmetic, deferred by design, speculative, or pure
  architecture debt.

Label newly filed issues when you file them. Readability gaps in cs2gs output
or in the translated source go under the single post-cut-over cleanup issue
instead of one issue per synthesized name.

## Coordinating multiple agents

For sessions that delegate work to subagents:

- **Isolation:** each agent that commits gets its own git worktree and its
  own branch or PR. Never let an agent work in the main checkout.
- **Keep the coordinator's state log on disk,** not in `/tmp` or the
  scratchpad (see "Keep durable state off tmpfs" above).
- **Briefs are self-contained:** include the issue, the relevant ADR
  decisions, the landing criteria and the process rules above, including the
  N-1 rule. Agents don't inherit them automatically.
- **The coordinator merges.** Before merging, verify the agent's claims
  directly: CI status, unresolved threads, and whether the latest review
  covers the head commit.
- **Keep one agent per PR** across review rounds. Resume it with the new
  findings rather than starting a fresh agent that lacks the history.
- **Relay review findings with their exact thread ids and file:line.** Name
  the landing rule that applies to each one.
