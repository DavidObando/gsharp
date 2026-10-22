# Contribute to G#

Before a large change, use a new issue or an open issue.
Agree on the scope and language behavior of the pull request (PR) with the maintainer.

## Repository source

The compiler, language server, formatter, and tools use G# (`.gs`, `.gsproj`).
Change the G# source on `main`.

Keep these files in C#:

- The Visual Studio extension in `src/vs-gsharp`.
- The helper `build/selfhost/PeBodyMutations.cs`.
- The C# test fixtures and translator inputs, which include `tools/cs2gs/corpus` and `*.cs.txt`.

The branch `cs2gs/csharp-0.4` supplies C# input for cs2gs tests.
Only the maintainer changes this branch.
See [the migration documentation](docs/self-migration-cutover.md) for previous decisions.

## Prerequisites

Install these tools:

- The .NET SDK specified in [`global.json`](global.json).
- Git.
- Node.js 24, for changes to `website` or the VS Code extension.
- Visual Studio on Windows, for changes to `src/vs-gsharp`.

### The N-1 rule

The repository builds with the previous released compiler.
The `Gsharp.NET.Sdk` entry in `msbuild-sdks` in `global.json` gives the compiler version.

Use only language features that this compiler supports in repository source, tests, tools, and samples.
Do not use a new language feature in the PR that adds the feature.
Wait until `global.json` specifies a release that contains the feature.

Change the compiler version in a different PR.
Build from a clean clone with that version.
Record the version in the release notes.
Do not use a local SDK or an SDK without a release to make a build pass.

See [the bootstrap instructions](docs/self-host-bootstrap.md) for the build stages.
Stage-2 certification is optional.
It is not a requirement for a PR or a release.

## Build and format

Run these commands from the repository root:

```sh
dotnet restore GSharp.slnx --locked-mode
dotnet tool restore
dotnet build GSharp.slnx --configuration Release --no-restore -graph
```

Use `-graph` to prevent two builds of the same project at the same time.
Warnings are errors.
Change `packages.lock.json` files only when the PR changes dependencies.

Format the G# files:

```sh
dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --write .
dotnet out/bin/Release/Gsfmt.Cli/gsfmt.dll --check .
```

For extension builds, use the [VS Code instructions](src/vscode-gsharp/README.md) or [Visual Studio instructions](src/vs-gsharp/README.md).

## Tests

Run the tests that cover the change.
Use a project and a filter to limit the test run:

```sh
dotnet test test/Compiler.Tests/Compiler.Tests.gsproj --configuration Release --no-build --no-restore --filter 'FullyQualifiedName~LanguageConformance'
```

Continuous integration (CI) runs the full test suite in separate jobs.
Do only the applicable local tests.
Run applicable scripts in [`e2etests`](e2etests/) for SDK, template, debugger, package, or generated-project changes.

The necessary checks are `ci` and `docs-ci`.
PR workflows select affected components and their consumers with `build/ci-selection.py`.
Unknown inputs cause full validation.
Official builds use full validation.
See [ADR-0200](docs/adr/0200-component-aware-pr-validation.md).

For changes to CI selection or test distribution, run these tests:

```sh
python3 build/test-ci-selection.py
python3 build/test-ci-test-matrix.py
```

Keep MSBuild node reuse disabled in `Cs2Gs.Tests`.
Keep xUnit test execution serial in that project.
`TestHostProcessSetupTests` makes sure that the project obeys these requirements.

### Show that a test finds the error

For each new or changed behavioral test, obey [ADR-0154](docs/adr/0154-test-oracle-strength.md).
Record a failure without the correction and a pass with the correction.
For the failure, use the previous commit, a revert of the correction, or a mutant.
A mutant is a temporary change that causes the error.
Driver tests must use the driver that users use.

Use these assertions:

- Compare emitted output bytes with the correct bytes.
- Assert diagnostic IDs and source locations for rejected code.
- Assert that a collection is not empty before `Assert.All` or an equivalent assertion.

### Golden files

Use the shared `GoldenFile` helper for file snapshots.
On a mismatch, the helper writes `<golden>.actual`.
Examine this file before you accept a change:

```sh
GSHARP_UPDATE_GOLDENS=1 dotnet test <project> --filter <golden-test>
```

Run the applicable pipeline test after a change to a cs2gs `baseline.stdout.golden` file.
After `cs2gs coverage --write`, examine the inventory and [coverage matrix](docs/cs2gs-coverage-matrix.md).

## Design and comments

Make an architecture decision record (ADR) for changes to public syntax, semantics, compatibility, or architecture for multiple components.
Use [the ADR template](docs/adr/0000-template.md).
Use the next ADR number.
Include the issue link and changes to the applicable reference documents.

Keep each change in the agreed scope.
Use helpers and code patterns from the repository.
If a change can cause incorrect code, report a diagnostic or stop execution.

Use the writing rules of ASD-STE100 Simplified Technical English for code comments.
Keep instructions to 20 words for each sentence.
Keep descriptions to 25 words for each sentence.
Use one topic for each sentence.
Use active verbs.
Use the same technical name for the same thing.

Give constraints in comments.
Use issue or ADR links to tell why the constraints are necessary.
Do not give a history of the code.
Use `///` for API documentation and `//` for implementation notes.
Do not change tool directives, `@param`, `@returns`, or `(cref:...)` references.
Remove references to tools or CI jobs that the repository no longer uses.

For changes to comments only, run this check:

```sh
python3 build/check-comment-only-diff.py --base origin/main
```

The check supports `.gs` files only.
It compares compiler tokens and documentation structure.
Keep the space between tokens when you remove an inline comment.
For other file types, compare the changes manually.
Run the applicable tests when the test input includes comments.

## Documentation

For website changes, run these commands:

```sh
cd website
npm ci
npm run typecheck
npm run test:content
npm run build
```

The production build rejects broken links.
Change development documentation in `website/docs`.
Change released documentation in `website/versioned_docs` only for an agreed version update.
See [the documentation instructions](docs/docs-authoring.md).

## Pull requests

Use these requirements for each PR:

- Include `Fixes #NNNN` or `Part of #NNNN` for the issue.
- Include related tests, documentation, and generated files with the source change.
- Complete the PR template with validation results and ADR-0154 test results.
- Keep build output, `.actual` files, credentials, and local logs out of commits.
- Keep applicable provenance labels, such as Oahu, Oats, and Claude Code.
- Correct errors that prevent the merge.
- Record remaining work in issues.

Report security vulnerabilities through [`SECURITY.md`](SECURITY.md), not public issues.
Automated contributors must obey the same requirements.
See [`CLAUDE.md`](CLAUDE.md) for agent instructions.
