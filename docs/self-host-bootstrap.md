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

## Packing stage 1

```sh
python3 build/selfhost-pack-stage1.py \
  --tree <migrated-tree> \
  --bootstrap <Gsharp.NET.Sdk.<v>.nupkg> \
  --out <dir> [--version <stage1-version>] [--work <dir>]
```

The script changes the tree in place, idempotently, and records every change in `<work>/stage1-report.json`:

- Project/global configuration writes and feed archives publish through one atomic boundary: fully write/close and copy required metadata to an exclusively owned sibling file in the destination directory, then replace the destination and immediately record the committed mutation. Late write/close/metadata failures leave the destination unchanged or absent and remove only that owned sibling. Project bytes retain their BOM/newlines and permissions; changed text gets normal write timestamps. Symlink, hard-linked and non-regular destinations and symlinked publication directories are rejected rather than silently changing linked data. Expected I/O and decoding failures return an error with the exact committed partial report, not success.
- Core's generated SDK pin is rewritten last, preserving the canonical version while other projects normalize. After repairing a failed project read/write, a second prepare can finish the remaining pins without rollback or guessing a version from other projects.
- Malformed `global.json`, including unterminated block comments, fails with its path and parse location in the report, retaining completed pin changes and leaving the invalid configuration bytes untouched. Comment markers inside strings, escaped quotes, valid comments and trailing commas remain supported. Repairing that configuration lets a later prepare proceed; unsupported non-object configuration shapes remain errors rather than being replaced.
- It stages the stage-0 nupkg and each version of `GSharp.CodeAnalysis.Analyzers.Testing` referenced by the tree into `.nugs`. Each required archive must be beside the bootstrap, under its original package ID and version; the verifier version is independent of the SDK version. Without a reference, the bootstrap-version sibling remains optional and its absence is only reported.
- Verifier references must use an unconditional `PackageReference Include` with a literal `Version` attribute or child element. Literal package versions share the SDK/stage-1 admission rule: three or four numeric components, with an optional prerelease suffix; the entire value must match. Namespaced XML is supported. The preparation scan includes in-tree projects, `.props` and `.targets`; it is not an MSBuild evaluator. Updates/removals, item defaults, version overrides, central/property/range versions, unresolved item identities and conditional/target contexts fail explicitly rather than guessing a version. A self-contained migrated tree is required; references introduced only by out-of-tree imports are not certified by this scan.
- Archive admission and stage identities use NuGet normalization within that literal domain: numeric leading zeros disappear, a zero fourth component is omitted, and prerelease identity is case-insensitive. Numeric components must fit NuGet's Int32 domain; numeric prerelease labels cannot have leading zeros. Requested verifier literals remain in reports/projects; the bootstrap nuspec literal remains in its report/global pin/default version. Archives are located by equivalent identity and their sole nuspec ID/version must agree with the filename. Equivalent references stage once; byte-different alias archives fail as ambiguous rather than selecting one silently. Produced stage-1 filenames use the normalized version, while stamped metadata and reports retain the requested literal. A stage-1 version equivalent to bootstrap is rejected even when its spelling differs.
- The repository's simple item aliases for unrelated packages remain supported when all their in-tree definitions identify literal package IDs. An alias that can carry the verifier, or an unresolved alias, is rejected; the script does not infer verifier versions from item definitions.
- It pins `Gsharp.NET.Sdk` once, under `msbuild-sdks` in `global.json`. The file is rewritten as plain JSON, so comments and formatting are not kept (the repository's `global.json` has none). A BOM is kept. A tree migrated with `cs2gs migrate --sdk-pin global-json` is already bare. In a per-project tree, the generated pin is the one on `src/Core/Core.gsproj`, and it is rewritten to the bare name wherever it appears. Pins on samples and templates are intentional and are left alone.
- MSBuild lets a versioned `Sdk` attribute silently override `global.json`, so the script fails if a toolchain project still carries one.

It restores the projects that the SDK's `Pack*` targets build through nested `<MSBuild>` calls, then runs `dotnet pack` on the SDK project.
Nerdbank.GitVersioning ignores `-p:PackageVersion` (and outside git it packs as `<major>.<minor>.0-g`), so the script stamps
the stage-1 version (default `<full bootstrap numeric version>-stage1`, for example `1.2.3.4-stage1`) into the nuspec of the package and its `.snupkg` afterwards. That version must differ from the
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
