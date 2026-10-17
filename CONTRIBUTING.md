# Contributing to G#

G# accepts focused bug fixes, tests, documentation, and agreed language or
tooling changes. Open or claim an issue before substantial work so semantics
and scope are settled before code is written.

## The repository is built with G#

The compiler, language server, formatter and tools are G# source (`.gs`,
`.gsproj`). Three parts of the repository are deliberately still C#:

- `src/vs-gsharp` (the Visual Studio extension). It targets .NET Framework and
  keeps its `#if NETFRAMEWORK` directives. It builds on Windows only and
  references the G# language server.
- `build/selfhost/PeBodyMutations.cs`, a file-based `dotnet run` helper that
  `build/test-selfhost-stage2.py` runs by file name. (The stage-2 controller's
  helper projects beside it, `PackageContentHash.gsproj` and
  `TestSupervisorLogger.gsproj`, are G#; the controller builds those exact
  paths, so do not rename them.)
- Test fixtures and cs2gs inputs that are C# on purpose (for example
  `tools/cs2gs/corpus` and `*.cs.txt` source data). They are the C# the
  translator is tested against.

The final C#-built release is `v0.4.1270`; its C# source of the compiler lives
on branch `cs2gs/csharp-0.4`, which is **semi-frozen**: a living corpus for
cs2gs. **Fixes happen in G#, on `main`.** Do not open bug-fix or feature PRs
against the C# branch. It receives only code back-ported from G# to C# when that
code merits exercising cs2gs, and a security fix released as `0.4.1270+k`. Both
are made by the maintainer, and the cs2gs apps nightly
(`.github/workflows/cs2gs-apps-nightly.yml`) pins a SHA of the branch in
`tools/cs2gs/external/gsharp-csharp.json`. That nightly runs cs2gs as built from
`main` (written in G#) over the C# source on that branch, plus Oahu and Code
Exploder.

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
`global.json`, build from a clean clone, and note the new version in the
release notes. That PR's green CI with the new pin is its stage-2 verification:
each release is the repository built by the previous pin (stage 1 of its tag),
so building `main` with it is stage 2.

See [`docs/self-host-bootstrap.md`](docs/self-host-bootstrap.md) for how stage 0
(the pin), stage 1 and stage 2 relate. The isolated stage-2 controller
(`build/selfhost-stage2.py`,
[ADR-0198](docs/adr/0198-isolated-stage-2-self-host-certification.md)) is
background and optional, owner-run evidence, not a merge requirement.

## Restore and build

```sh
dotnet restore GSharp.slnx --locked-mode
dotnet tool restore
dotnet build GSharp.slnx --configuration Release --no-restore -graph
```

Restore uses the checked-in NuGet lock files (`packages.lock.json`). Do not
update lock files unless dependency changes are part of the PR.

`-graph` matters: it prevents duplicate project builds from racing over shared
compiler outputs. Warnings are errors.

Format `.gs` files with gsfmt. CI runs the check twice; run the write mode
locally until it is clean:

```sh
dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --write .
dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --check .
```

### Editor extensions

The VS Code extension builds with npm. Press F5 in VS Code to launch an
Extension Host with it:

```sh
cd src/vscode-gsharp
npm install
npm run compile
```

The Visual Studio extension builds from a Visual Studio Developer PowerShell:

```powershell
msbuild src\vs-gsharp\VsGsharp.sln /restore /t:Build /p:Configuration=Release
```

The VSIX is written to
`src\vs-gsharp\src\VsGsharp\bin\Release\net472\GSharp.VisualStudio.vsix`.
To try it in an experimental instance:

```powershell
src\vs-gsharp\scripts\Install-ExperimentalVsix.ps1 -RootSuffix GSharp
src\vs-gsharp\scripts\Invoke-Vs2026Smoke.ps1 `
  -RootSuffix GSharp `
  -SolutionPath path\to\sample.sln
```

The installer removes only the selected experimental profile's MEF,
extension metadata, and project-template indexes. It then warms that profile
before a solution is opened.

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

## Code comments

Write comments in plain technical English. Follow the writing rules of
ASD-STE100 (Simplified Technical English), not its restricted dictionary.

What to write:

- Say what the code does and why: the constraint, the invariant, or the
  external fact that makes it correct. Do not tell how the code got there.
  To give the reason, cite the issue or ADR (`Issue #4133`, `ADR-0186`).
- Do not name a workflow, script, gate, job, or CI run that no longer exists.
- Write `///` doc comments for the user of the API, because they ship as
  IntelliSense text. Put implementation notes in `//` comments.
- Do not change comments that a tool reads, such as `// <auto-generated/>`,
  `# shellcheck` and `# noqa`. In a doc comment, keep the `@param` and
  `@returns` tags and the `(cref:...)` targets (ADR-0057). Reword only the
  prose.

How to write it:

- Write one topic in each sentence. Keep an instruction to 20 words or fewer
  and a description to 25 words or fewer.
- Use the active voice, the present tense for behavior, and the imperative
  for instructions: "The binder reports GS0281", "Call `Reset` first".
- Do not put more than three nouns in a row.
- Use one name for one thing, and use the name that the code uses.
- Do not use idioms or slang.
- Prefer a period to an em dash (—) or a semicolon. Use commas or
  parentheses for a short aside. A semicolon between two short, related
  clauses is acceptable.

Words to avoid:

| Avoid | Write instead |
| --- | --- |
| load-bearing | required, or say what depends on it |
| belt and suspenders, defense in depth (for a second check) | a second check, and say what it catches |
| crucial(ly), importantly, notably, note that, it is worth noting | (delete), and state the fact |
| genuine(ly), actually, honest(ly) | (delete), or real, correct |
| simply, just, essentially, basically (as filler) | (delete) |
| deliberately, intentionally | keep only for a choice that looks like a bug, and give the reason |
| in order to | to |
| paper over | hide |
| under the hood | internally, or name the component |
| guardrail | check, negative test |
| robust(ly), cleanly | say which input it handles, or "without errors" |
| sanity check | check |
| surgical | small, exact |
| smoking gun | the cause |
| footgun, sharp edge | an easy mistake, and say what it is |
| heavy lifting | the main work |
| delve, leverage (verb), seamless(ly) | look at, use, (delete) |

Check a comment-only change with:

```sh
python3 build/check-comment-only-diff.py --base origin/main
```

It passes only if each changed file differs from the base in its comments.
A change inside a string literal fails, and so does a change to a Python
docstring or to a YAML block scalar such as `run: |`. A comment in a test
input (the cs2gs corpus, or a fixture that a test reads) can be test data, so
run the tests that read the file.

## Documentation site

```sh
cd website
npm ci
npm run typecheck
npm run build
```

Broken links fail the production build. Current docs live in `website/docs`;
released snapshots under `website/versioned_docs` change only during an
intentional version cut. Page conventions, examples, links and versioning are
in [`docs/docs-authoring.md`](docs/docs-authoring.md).

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
