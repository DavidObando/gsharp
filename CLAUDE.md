# Working in this repository (for Claude Code and other agents)

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. It covers building, testing,
discriminating tests (ADR-0154), design changes needing an ADR, and PR
hygiene. This file adds operational knowledge that has repeatedly cost time
when it was missing. When a rule here conflicts with a maintainer's explicit
instruction, follow the maintainer.

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

- **nullable-hygiene** runs `python3 build/nullable_hygiene.py --base
  origin/main`. Run it locally before pushing.
  - Every null-forgiving `!` needs an adjacent comment justifying it.
  - `= null!` initializers are rejected (ADR-0155).
  - Where a value really can be null, prefer restructuring over commenting
    the `!` away.
- **hot-core translation guard** (`build/run-cs2gs-selfmig-pr-guard.sh`)
  usually takes 30-60 minutes. It migrates a small set of net10 apps built
  against a fully annotated BCL. So it **cannot** catch regressions that only
  show up with unannotated or netstandard2.0 dependencies; issue #4361 is an
  example of one that slipped through.
- **Nightly self-migration** (`.github/workflows/cs2gs-selfmig-nightly.yml`)
  is the full-corpus gate, with a floor of all apps green. To verify a fix
  that affects migration, trigger it manually on `main` after merging:
  `gh workflow run cs2gs-selfmig-nightly.yml --ref main`.
- **cs2gs-oahu** migrates Oahu at the commit pinned in
  `tools/cs2gs/external/oahu.json`.
  `JobSchedulerTests.Bounded_Concurrency_Limit_Is_Enforced` is a known flaky
  test (DavidObando/Oahu#71). Show that a failure isn't yours before
  rerunning.
- **Build docs** (`pages.yml`): the WebKit dark-theme accessibility check on
  `project/quality-dashboard` fails intermittently. When a PR doesn't touch
  that page, rerun it with `gh run rerun <run-id> --failed`.
- **`Issue3347RemainingSpillInventoryTests`** translates code through cs2gs
  and fails if the output contains retired synthesized names. It has two
  scopes:
  - `src/Core` is checked for all four families: `__spill`, `__cast`,
    `__decon` and `__using`.
  - The cs2gs translator project is checked for `__spill` only.

  If it fails, change the new C# code (or cs2gs) so the translation doesn't
  produce the name. Don't weaken the test. Its translator scope doesn't cover
  the other three families, so don't treat it as a gate for them.
- **Flaky or not, check the logs first.** Pull the job log
  (`gh api repos/DavidObando/gsharp/actions/jobs/<id>/logs`) and show that
  the failure is unrelated, e.g. the same failure on `main` or on an
  unrelated PR, before rerunning.

## Local environment

- **Test scope:** run targeted `--filter` test runs locally. Full suites run
  on PR CI.
- **`/tmp` is a shared tmpfs of about 31 GB.** Self-migration and hot-core
  runs fill it quickly, and when it fills every Bash command fails silently
  for everyone on the machine. Put their work roots
  (`SELFMIG_PR_GUARD_ROOT`, `--out`, `--artifacts`, `TMPDIR`) under
  `~/.cache/<tag>/`, and delete them when you're done.
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
Before touching it, read:

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
  - **Phases 2–3:** add the rest of the query API, and the analyzers that
    enforce the funnel (GSA0007/GSA0008, plus GSA0009 for cs2gs in Phase 5).
    After they land, consumers use the query API instead of writing their own
    `is NullableTypeSymbol` tests.
- **Settled decisions** (don't reopen them without the maintainer):
  - `[Nullable(2)]` on an open type-parameter slot: a reference-type argument
    gives `T?`; a value-type argument is left unchanged, with no wrapping
    (`Min<int>()` returns `int`).
  - An in-scope unconstrained type parameter is left unchanged. Revisiting it
    as `T!` is tracked in #4385, after ADR-0193 Phase 3.
- **Stated-nullable member chains need `!!` or `?.`.** gsc no longer has a
  carve-out for these (#4356), and cs2gs emits `!!` itself. `?.` changes the
  result type (`T` → `T?`), so it isn't a drop-in replacement for a C#
  dereference; `!!` is.

## Issue triage

Every open issue carries exactly one of `P0`, `P1` or `P2`:

- **P0:** actively breaking something. Examples: a red gate on `main`, a
  merge-blocking regression, a process crash or silent miscompile reachable
  in default mode, a security issue. Keep these rare.
- **P1:** a confirmed bug with concrete impact and a repro. This includes
  invalid IL or ILVerify failures, internal compiler errors (GS9998) on valid
  code, and cs2gs dropping semantics without a diagnostic.
- **P2:** minor, cosmetic, deferred by design, speculative, or pure
  architecture debt.

Label newly filed issues when you file them.

## Coordinating multiple agents

For sessions that delegate work to subagents:

- **Isolation:** each agent that commits gets its own git worktree and its
  own branch or PR. Never let an agent work in the main checkout.
- **Briefs are self-contained:** include the issue, the relevant ADR
  decisions, the landing criteria and the process rules above. Agents don't
  inherit them automatically.
- **The coordinator merges.** Before merging, verify the agent's claims
  directly: CI status, unresolved threads, and whether the latest review
  covers the head commit.
- **Keep one agent per PR** across review rounds. Resume it with the new
  findings rather than starting a fresh agent that lacks the history.
- **Relay review findings with their exact thread ids and file:line.** Name
  the landing rule that applies to each one.
