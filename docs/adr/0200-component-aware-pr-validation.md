# ADR-0200: Component-aware pull request validation

- **Status**: Accepted
- **Date**: 2026-10-18
- **Phase**: CI iteration
- **Related**: #5006, ADR-0154

## Context

Each pull request builds and tests unrelated components. Test shards and the
partition verifier also build the entire solution. Test execution filters alone
do not remove that cost. Individual required shard checks prevent matrix jobs
from being omitted.

Official builds publish artifacts and must retain their existing validation.
The C# corpus branch family shares the current protection ruleset with `main`.

## Decision

Use `build/ci-selection.py`, with only Python standard-library dependencies,
in both PR workflows. Read the complete three-dot Git diff between the event's
base and head SHAs. Include deleted paths and both paths of renames. Diff errors
fail selection. Unknown paths and new test projects select full validation.
Report each path's component and the selected jobs in the run summary.

Route by component before considering prose. Fixtures, corpus files and samples
remain inputs to their consumers, including Markdown files. Components select
their owning suites and downstream consumers. Shared configuration and workflow
changes select all jobs. Website content selects existing site, browser and
visual checks. Go-only inputs select the three existing platform checks from
#4562; those jobs stay dormant until the Go module lands.

Filter the canonical test matrix by project, including individual members of
`fast-suites`. Use the same project selection for partition verification.
For PRs, restore and build native solution filters containing selected roots.
Keep dependency configurations from the solution and traverse their graph once.
Keep the pinned C# checkout and build in the cs2gs shards.

Select independent harness contracts separately from test partitioning.
Official events retain full solution commands, test selection, artifacts,
deployment conditions and publish dependencies. The extracted harness job
remains a publication dependency.

Both workflows start on every PR. Stable `ci` and `docs-ci` jobs run with
`always()` and require success from selection and every selected dependency.
Missing, skipped, failed or cancelled selected jobs fail the aggregate.
Keep existing docs push filters, schedules and snapshot refresh behavior.

After the rollout PR passes full CI and current-head review, run
`python3 build/migrate-ci-rules.py --apply`. First create a `main` ruleset
requiring `ci` and `docs-ci`. Then restrict the original ruleset to
`cs2gs/csharp*`, retaining every existing rule, status check and bypass actor.
The default invocation prints the proposed rulesets without changing them.

## Consequences

Unrelated compiler test suites and extension builds no longer delay scoped PRs.
Component builds still include compiler and SDK dependencies when required.
Unknown inputs cost a full run instead of losing coverage. New suites require
an explicit classification before scoped selection resumes.

The dependency table needs updates when a component gains a new consumer.
Conservative selections can run more checks than necessary. The full rollout
run and router contract tests guard the initial transition.

## Alternatives considered

- File-extension filters misclassify executable fixture data and project changes.
- Separate workflow path filters can leave required checks pending.
- Filtering test execution alone retains unrelated solution builds.
- Changing official builds adds release risk without helping PR iteration.
