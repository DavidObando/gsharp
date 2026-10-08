# Self-host bootstrap: stage 0, stage 1, stage 2

Issue [#4631](https://github.com/DavidObando/gsharp/issues/4631). The compiler is moving to G# source.
Bootstrapping it takes three compilers:

| Stage | Compiler | Built from | Built by |
|---|---|---|---|
| 0 | C#-built `Gsharp.NET.Sdk` (today this repository's nupkg; at the cut-over the final released 0.4.x) | C# source | csc |
| 1 | stage-1 `Gsharp.NET.Sdk` | the cs2gs-migrated G# tree | stage 0 |
| 2 | the migrated tree rebuilt | the same G# tree | stage 1 |

The cut-over requires stage 2 to reproduce stage 1. The certification contract
is defined by
[ADR-0198](adr/0198-isolated-stage-2-self-host-certification.md). It requires
immutable isolated source and build trees, controller-owned evidence, graph and
toolchain revalidation at each build/test boundary, and complete-PE equality
except for the exact validated `Module.Mvid` GUID slot. Draft PR #4693 is an
in-place prototype and discrimination inventory. It is not a landable
certification gate.

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
  --test 'test/Core.Tests/Core.Tests.csproj::<filter>'
```

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

## Windows: the migrated Core.Tests on a 1 MB stack

The compiler recurses deeply: the binder, lowering and emit all walk syntax and bound trees. Windows gives the main thread
a 1 MB stack (Linux: 8 MB), and the frame sizes of G#-compiled code have never been measured. The workflow
`.github/workflows/selfhost-windows.yml` (manual dispatch; it also runs on pull requests that change it) does the following:
- It takes the migrated tree from a `cs2gs-selfmig-nightly` run (default: the latest successful one) and replays that run's polish deltas.
- Git Bash extracts polish archives using POSIX paths; the resulting tree is passed to native tools and Actions as a Windows path.
- The C# checkout keeps LF line endings, like the migrated artifact, so raw-string theory arguments have matching xUnit test names.
- It pins the tree to the commit's own C#-built SDK (`selfhost-pack-stage1.py --prepare-only`).
- It runs the C# and the migrated Core.Tests on the same `windows-latest` runner.
- The migrated suite receives `CS2GS_TEST_SOURCE_ROOT` pointing to the original C# checkout, matching the stage-4
  source-root contract. Older nightly artifacts have C#-only source guards and cannot discover it from the downloaded tree.

`build/selfhost-compare-trx.py` compares the two runs by failing-test multiset. Duplicate display names remain separate
executions, and additional failing rows cannot be hidden by a passing row with the same name. The job fails if the migrated suite fails a test
that the C# suite passes, or executes fewer than 95% of the tests the C# suite does (a crashed test host, such as a stack overflow).
Failures the C# suite already has on Windows (tracked by `windows-nightly`) are reported, not counted.
An empty C# baseline also fails: it cannot establish migration parity. The existing Windows test failures are tracked in
[#4635](https://github.com/DavidObando/gsharp/issues/4635); this lane does not skip or weaken those tests.
Both TRX files must describe completed runs (`Completed`, `Passed` or `Failed`): an aborted, errored or missing run summary
fails independently of the execution ratio. Completed runs with shared assertion failures remain valid for comparison.
