# Self-host bootstrap: stage 0, stage 1, stage 2

Issue [#4631](https://github.com/DavidObando/gsharp/issues/4631). The compiler is written in G# source since the 0.5 cut-over (see [`self-migration-cutover.md`](self-migration-cutover.md)).
Bootstrapping it takes three compilers:

| Stage | Compiler | Built from | Built by |
|---|---|---|---|
| 0 | the `Gsharp.NET.Sdk` release pinned in `global.json` (at the cut-over, the C#-built `0.4.1270`; since then a G#-built 0.5.x release) | the source of that release | the release before it (csc for the 0.4 line) |
| 1 | stage-1 `Gsharp.NET.Sdk` | the repository's G# source | stage 0 |
| 2 | the same G# tree rebuilt | the same G# tree | stage 1 |

The cut-over required stage 2 to reproduce stage 1, and was certified that way
(see [`self-migration-cutover.md`](self-migration-cutover.md)). The
certification contract is defined by
[ADR-0198](adr/0198-isolated-stage-2-self-host-certification.md). It requires
immutable isolated source and build trees, controller-owned evidence, graph and
toolchain revalidation at each build/test boundary, and complete-PE equality
except for the exact validated `Module.Mvid` GUID slot. Draft PR #4693 was an
in-place prototype and discrimination inventory; it was closed without landing.

How the cut-over was bootstrapped and certified (owner decision recorded in
#4631):

- **Stage 1 (bootstrap):** the G# source compiled by the published
  `Gsharp.NET.Sdk` **0.4.1270**, the final C#-built SDK, pinned once in the
  repository's `global.json` `msbuild-sdks`.
- **Stage 2 (certification):** the G# source compiled again by the stage-1
  compiler. The cut-over was accepted only when stage 1 and stage 2 produced
  identical PE bytes for `GSharp.Core.dll` and `gsc.dll`, except the
  structurally validated 16-byte `Module.Mvid` GUID slot, and
  `RefactoringBaselineTests`, Core.Tests and Compiler.Tests passed under
  stage 2.
- The pin then moved from 0.4.1270 to 0.5.7, a 0.5 release. Since then, each
  release is the repository built by an earlier G# release, as described
  below.

Where the C# source went, and the N-1 rule for repository source, are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

After the cut-over, every release is the repository built by the previous pin,
so a release is stage 1 of its tag. A pin-move PR builds `main` with that
release, which makes its green CI the stage-2 verification. The controller below
is optional, owner-run evidence; it is not a merge or publish requirement.
A cheap two-build fixpoint comparison in CI is tracked in
[#4925](https://github.com/DavidObando/gsharp/issues/4925).

The replacement controller is `build/selfhost-stage2.py`. It creates a new
controller-owned work root, freezes one source snapshot, derives separate stage
trees, runs graph discovery, restore, build, pack, test, and output acceptance
inside restricted command boundaries, and writes evidence outside both build
trees. The work path must not exist before the run.

```sh
python3 build/selfhost-stage2.py \
  --tree <prepared-migrated-tree> \
  --bootstrap <stage-0-Gsharp.NET.Sdk.nupkg> \
  --work <new-controller-root-under-cache> \
  --project src/Core/Core.gsproj \
  --project src/Compiler/Compiler.gsproj \
  --assembly Core/GSharp.Core.dll \
  --assembly Compiler/gsc.dll \
  --test 'test/Core.Tests/Core.Tests.gsproj::<filter>' \
  --test-env GSHARP_SKIP_ILVERIFY=1 \
  --test-adapter-sha256 c5ac41b36fac0fcef9714fb80fea0175913530fb53dd7bb8e5e1470339667100 \
  --test-adapter-sha256 194458c816e0ea9ff0c5eac8896c52133fe9205661833b3d0f57e85a4e66936b \
  --test-adapter-sha256 ec705ad62e33f31fc46ad5800c9b1694c02d0ec4e1ee704712da9f24ebbea22e \
  --test-adapter-sha256 3166dc70323fb30ccf1cedb0fe86f2ad122c46d254542342d90386efc4c9285c
```

Tests run from a verified disposable copy of the accepted stage-2 outputs,
because suites write scratch files next to their own assembly. The copy is
checked against the accepted hashes before the run, and the certified outputs
stay read-only and are re-verified afterwards. The test host gets
`CS2GS_TEST_SOURCE_ROOT` (the immutable stage tree) and only the allowlisted
`--test-env GSHARP_SKIP_ILVERIFY=1` (shown above, required because the
sandbox has no `dotnet-ilverify`), which is recorded in the report. Tests that cannot run outside the repository
layout fail identically under stage 1 and are excluded by name in
`build/selfhost/stage2-env-bound-tests.json` until
[#4873](https://github.com/DavidObando/gsharp/issues/4873) is fixed.

The controller trusts only a pinned .NET layout and a run takes about eight
hours, so it fits neither a hosted runner's toolchain nor its six-hour limit
([#4885](https://github.com/DavidObando/gsharp/issues/4885)); no CI workflow runs
it. `python3 build/selfhost-stage2.py --probe-toolchain` reports in seconds
whether a machine qualifies. `build/verify-stage2-report.py` rejects a report
unless it is a real `certified: true` with equal `GSharp.Core.dll` and `gsc.dll`
and positive passing tests. Recorded runs on the 0.4.13xx line certified with
both assemblies byte-identical (the MVID slot happened to match too), with 11229
Core.Tests and 6990 Compiler.Tests passing under stage 2. Those counts are the
selected tests: the environment-bound exclusions above are not included.

Stage-2 v1 rejects symbolic links, hard links, dirty Git inputs, versioned
project SDK overrides, multitargeting, context-changing or build-disabled
references, secret-bearing restore configuration, and unmodeled project targets
or tasks. The current-closure hash allowlist contains the
`Gsharp.Extensions` compile-item reset, SDK packing targets, bootstrap imported
targets and task declaration, plus exact definitions from the pinned
Nerdbank.GitVersioning, Microsoft.SourceLink, Microsoft.Build.Tasks.Git,
Microsoft.NET.Test.Sdk, Microsoft.CodeAnalysis.Analyzers, and coverlet.collector
packages, and Microsoft.CodeCoverage and Microsoft.Extensions.Logging.Abstractions
and Microsoft.Extensions.Options packages.
Restore is offline inside the restricted boundary; required packages must
already be available from the frozen local inputs.

## Packing stage 1

```sh
python3 build/selfhost-pack-stage1.py \
  --tree <migrated-tree> \
  --bootstrap <Gsharp.NET.Sdk.<v>.nupkg> \
  --out <dir> [--version <stage1-version>] [--work <dir>]
```

The script changes the tree in place, idempotently, and records every change in `<work>/stage1-report.json`:

- It stages the stage-0 nupkg, plus its `GSharp.CodeAnalysis.Analyzers.Testing` sibling, into the tree's `.nugs` feed.
- It pins `Gsharp.NET.Sdk` once, under `msbuild-sdks` in `global.json`. The file is rewritten as plain JSON, so comments and formatting are not kept (the repository's `global.json` has none). A BOM is kept. A tree migrated with `cs2gs migrate --sdk-pin global-json` is already bare. In a per-project tree, the generated pin is the one on `src/Core/Core.gsproj`, and it is rewritten to the bare name wherever it appears. Pins on samples and templates are intentional and are left alone.
- MSBuild lets a versioned `Sdk` attribute silently override `global.json`, so the script fails if a toolchain project still carries one.

It restores the projects that the SDK's `Pack*` targets build through nested `<MSBuild>` calls, then runs `dotnet pack` on the SDK project.
Nerdbank.GitVersioning ignores `-p:PackageVersion` (and outside git it packs as `<major>.<minor>.0-g`), so the script stamps
the stage-1 version (default `<major.minor.patch>-stage1`) into the nuspec of the package and its `.snupkg` afterwards. That version must differ from the
bootstrap version, because NuGet package caches are keyed by id and version.

The package is verified before the script succeeds:

- Its `tools/`, `Sdk/` and `build/` payload must contain everything the stage-0 package does. Missing XML documentation files are reported, not fatal.
- `tools/compiler/gsc` and `tools/compiler/GSharp.Core` must have been compiled from `.gs` sources: their portable PDBs name `.gs` documents and no `.cs` ones.

Measured on the nightly 36930275716 tree (main `6c4824cbc`):

- Stage-1 pack (the migrated tree compiled and packed with stage 0): 25 minutes.
- Package payload: 150 entries.
- Extras over stage 0: G#-built executables also ship `Gsharp.Extensions`, `Gsharp.Runtime.Channels` and `Gsharp.Runtime.Values`.
- Missing docs: the XML documentation of the three executables.
