# Contributing to G#

G# accepts focused bug fixes, tests, documentation, and agreed language or
tooling changes. Open or claim an issue before substantial work so semantics
and scope are settled before code is written.

## The repository is built with G#

The compiler, language server, formatter and tools are G# source (`.gs`,
`.gsproj`). Two parts of the repository are deliberately still C#:

- `src/vs-gsharp` (the Visual Studio extension). It targets .NET Framework and
  keeps its `#if NETFRAMEWORK` directives. It builds on Windows only and
  references the G# language server.
- Test fixtures and cs2gs inputs that are C# on purpose (for example
  `tools/cs2gs/corpus` and `*.cs.txt` source data). They are the C# the
  translator is tested against.

The final C#-built release is `v0.4.NNNN`; its C# source of the compiler is
frozen on branch `cs2gs/csharp-0.4`. **Fixes happen in G#, on `main`.** Do not
open PRs against the C# branch. The exceptions (a back-port that cs2gs tests
need, or a security fix released as `0.4.NNNN+k`) are made by the maintainer.

## Prerequisites

- .NET SDK selected by [`global.json`](global.json)
- Git
- Node.js 24 only when changing [`website/`](website/) or the VS Code extension
- Windows with Visual Studio only when changing `src/vs-gsharp`

### The N-1 rule

The repository builds with the previous released compiler. The pin is the
`Gsharp.NET.Sdk` entry under `msbuild-sdks` in [`global.json`](global.json), and
it names a published release restored from nuget.org. Repository source may use
only language features that the pinned release supports.

If your PR adds a language feature, do not use it in repository source (`src/`,
`test/`, `tools/`, samples) in the same PR. Use it only after a release
containing it becomes the pin. Moving the pin is a separate PR: update
`global.json`, build from a clean clone, run the stage-2 check, and note the
new version in the release notes.

See [`docs/self-host-bootstrap.md`](docs/self-host-bootstrap.md) for how stage 0
(the pin), stage 1 and stage 2 relate.

## Restore and build

```sh
dotnet restore GSharp.slnx
dotnet tool restore
dotnet build GSharp.slnx --configuration Release --no-restore -graph
```

<!-- CUTOVER-VERIFY: restore command. Today `dotnet restore GSharp.sln --locked-mode`
     uses checked-in packages.lock.json files. Confirm the translated .gsproj files
     carry lock files (or that the cut-over adds them) before restoring
     `--locked-mode`; if they do, use it and say "do not update lock files unless
     dependency changes are part of the PR". Delete this comment. -->

`-graph` matters: it prevents duplicate project builds from racing over shared
compiler outputs. Warnings are errors.

Format `.gs` files with gsfmt. CI runs the check twice; run the write mode
locally until it is clean:

```sh
dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --write .
dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --check .
```

## Test

Run the smallest project and filter that covers the change:

```sh
dotnet test test/Compiler.Tests/Compiler.Tests.gsproj \
  --configuration Release --no-build --no-restore \
  --filter 'FullyQualifiedName~LanguageConformance'
```

The complete suite is memory-heavy and can exceed 45 minutes. CI shards it;
local full-suite runs are not expected for focused changes. Run relevant e2e
scripts under [`e2etests/`](e2etests/) when changing the SDK, templates,
debugging, packaging, or generated projects.

For a change to binding, lowering, emit or the runtime libraries, also run the
stage-2 check (`build/selfhost-stage2.py`, ADR-0198). The compiler compiles
itself, and a defect can be invisible until gsc builds gsc.

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
intentional residual work instead of dropping it. [`CLAUDE.md`](CLAUDE.md)
collects the operational details for agents: the review loop, CI gate
behaviour, bootstrap hazards, local-environment hazards, and
nullability-architecture rules.
