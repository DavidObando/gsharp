# Contributing to G#

G# accepts focused bug fixes, tests, documentation, and agreed language or
tooling changes. Open or claim an issue before substantial work so semantics
and scope are settled before code is written.

## Prerequisites

- .NET SDK selected by [`global.json`](global.json)
- Git
- Node.js 24 only when changing [`website/`](website/)

Restore uses checked-in NuGet lock files:

```sh
dotnet restore GSharp.sln --locked-mode
dotnet tool restore
```

Do not update lock files unless dependency changes are part of the PR.

## Build

```sh
dotnet build GSharp.sln --configuration Release --no-restore -graph
```

`-graph` matters: it prevents duplicate project builds from racing over shared
compiler outputs. Warnings are errors.

## Test

Run the smallest project and filter that covers the change:

```sh
dotnet test test/Compiler.Tests/Compiler.Tests.csproj \
  --configuration Release --no-build --no-restore \
  --filter 'FullyQualifiedName~LanguageConformance'
```

The complete suite is memory-heavy and can exceed 45 minutes. CI shards it;
local full-suite runs are not expected for focused changes. Run relevant e2e
scripts under [`e2etests/`](e2etests/) when changing the SDK, templates,
debugging, packaging, or generated projects.

`Cs2Gs.Tests` launches nested SDK builds. Its stability depends on both
invariants pinned by `TestHostProcessSetupTests`: MSBuild node reuse is disabled
(#2407) and xUnit test execution is serialized (#2689). Do not remove either
without an equivalent measured fix.

## Tests must discriminate

[ADR-0154](docs/adr/0154-test-oracle-strength.md) requires every new or changed
behavioral test to have a witness of discrimination. Record in the PR how the
test went red on the pre-fix commit, an exact revert, or a product mutant, then
green with the change. Real driver tests must invoke the real driver path.

Prefer:

- a regression test beside the affected subsystem;
- byte-for-byte output for emitted behavior;
- diagnostic IDs plus source locations for rejected code;
- non-empty assertions before `Assert.All` or equivalent quantifiers.

## Golden files

File snapshots use the shared `GoldenFile` helper. On mismatch, tests write
`<golden>.actual` and report the first differing line. Review that file, then
accept intended changes with:

```sh
GSHARP_UPDATE_GOLDENS=1 dotnet test <project> --filter <golden-test>
```

The cs2gs executable corpus uses `baseline.stdout.golden` through
`StdoutParity`; run the relevant pipeline test after changing one.

For the generated C# construct inventory:

```sh
cs2gs coverage --write
```

Review both the inventory and [`docs/cs2gs-coverage-matrix.md`](docs/cs2gs-coverage-matrix.md).

## Design changes

User-visible syntax, semantics, compatibility promises, or cross-cutting
architecture changes need an ADR. Copy
[`docs/adr/0000-template.md`](docs/adr/0000-template.md), use the next number,
link the issue, and update affected reference documentation.

Keep changes narrow. Reuse existing helpers and patterns. Do not add fallback
behavior that can silently produce wrong code; report a diagnostic or fail
loudly instead.

## Documentation site

```sh
python3 build/generate-quality-dashboard.py
cd website
npm ci
npm run typecheck
npm run build
```

Broken links fail the production build. Current docs live in `website/docs`;
released snapshots under `website/versioned_docs` change only during an
intentional version cut.

## Pull requests

- Link the issue with `Fixes #NNNN` or `Part of #NNNN`.
- Keep generated files, tests, and docs in the same PR as their source change.
- Fill in verification and ADR-0154 witness sections in the PR template.
- Do not commit build output, `.actual` snapshots, credentials, or local logs.
- Use normal GitHub review; disclose vulnerabilities through
  [`SECURITY.md`](SECURITY.md), never a public issue.

Automated contributors follow the same rules. Preserve Oahu, Oats,
Claude Code, or other provenance labels when applicable; automation does not
replace maintainer responsibility for the merge. A self-review may record
`MERGEABLE`, `BLOCKER`, `SHOULD-FIX`, or `NIT`; resolve blockers and file
intentional residual work instead of dropping it.
