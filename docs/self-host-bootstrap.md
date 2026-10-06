# Self-host bootstrap: stage 0, stage 1, stage 2

Issue [#4631](https://github.com/DavidObando/gsharp/issues/4631). The compiler is moving to G# source.
Bootstrapping it takes three compilers:

| Stage | Compiler | Built from | Built by |
|---|---|---|---|
| 0 | C#-built `Gsharp.NET.Sdk` (today this repository's nupkg; at the cut-over the final released 0.4.x) | C# source | csc |
| 1 | stage-1 `Gsharp.NET.Sdk` | the cs2gs-migrated G# tree | stage 0 |
| 2 | the migrated tree rebuilt | the same G# tree | stage 1 |

The cut-over requires stage 2 to reproduce stage 1: `GSharp.Core.dll` and `gsc.dll` must have identical normalized
PE images (only the precise `Module.Mvid` GUID slot is zeroed), and the test suites must pass under stage 2.

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

## Stage 2: the equivalence check

```sh
python3 build/selfhost-stage2.py \
  --tree <tree prepared by selfhost-pack-stage1.py> \
  --bootstrap <stage-0 nupkg> --stage1 <stage-1 nupkg> --work <dir> \
  [--project src/Core/Core.gsproj ...] [--assembly out/bin/Release/Core/GSharp.Core.dll ...] \
  [--test 'test/Core.Tests/Core.Tests.gsproj::FullyQualifiedName~RefactoringBaselineTests' ...] \
  [--config Release]
```

The PE helpers use .NET 10 file-based apps (`dotnet run <helper.cs> -- ...`), supported by the SDK
selected by this repository's `global.json`. They run from `build/selfhost`, which has no project file
and isolates them from the repository's build props and targets.

How it works:
- Before building, it verifies the stage-1 package's payload and G# compiler/Core PDB provenance using the stage-1 packer's verifier. Its SDK version must differ from the bootstrap version; supplying stage 0 twice cannot certify self-hosting.
- Before building, it evaluates the requested build and test project-reference closure in the same stage-specific environment and cleared package cache used by compilation. The closure must contain a validated G# project (a C# wrapper root may reference one through a build-enabled reference). Every participating G# project must inherit the requested `Gsharp.NET.Sdk` version from `global.json`, and the extracted `Sdk/`, `tools/` and `build/` payload must match the supplied nupkg byte-for-byte. Compiler/task paths are checked immediately before the SDK's `BuildTask` invocation; local-property exemptions, short-name/case variants of conflicting `BuildTask` registrations, and replacement `CoreCompile` targets that bypass the guarded task are rejected. Explicit, indirect, environment-conditioned or target-time overrides therefore fail the build. Outside-tree references, build-disabled or context-changing `ProjectReference` metadata, and multi-targeted inputs fail before cleanup. Unrelated intentional project pins remain untouched.
- It builds the projects twice in the **same tree path**: first pinned to stage 0 (which yields the stage-1 assemblies), then pinned to stage 1 (which yields the stage-2 assemblies). Each stage gets its own isolated package cache, cleared before that stage's build even when `--work` is reused. The stage-2 cache is retained for tests. Assembly snapshots have independent stage-local filenames even for parent-relative or absolute output paths. `--tree` and `--work` must be disjoint: neither may contain the other.
- Bootstrap, stage-1 and sibling package inputs must be outside every cleanup root or file: the migrated tree's `out` directory, stage snapshots, stage package caches, requested test-result directories, and each configured assembly/PDB output. Existing `.nugs` destinations may not alias any supplied input, and feed staging replaces destination entries atomically rather than following links.
- For each assembly pair it compares the full-file SHA-256 and a normalized-image SHA-256. `build/selfhost/PeContentHash.cs` retains every PE byte—including COFF/CLR headers, metadata, complete method bodies, managed resources and debug-wrapper data—except the single validated `#GUID` heap slot referenced by `Module.Mvid`. The existing IL-only RefactoringBaselineTests body hash is unchanged.
- Test projects run while pinned to stage 1 with the same stage-2 compilation-time toolchain guard, so everything they compile against is a stage-2 assembly and target-time compiler overrides fail. Every requested run must exit zero and produce fresh TRX evidence of a positive number of executed, passing tests. Missing, malformed, stale or zero-test evidence fails the gate. Each request has a separate results directory under `--work`; multiple target-framework TRX files are all checked.
- Default assembly outputs follow `--config` (Release by default); explicit `--assembly` paths are used unchanged.
- The verdict is "equivalent" only when every normalized-image hash matches. A full-file difference caused solely by the MVID is reported, not hidden.
- `build/selfhost/PeDiff.cs` explains a difference: it compares table row counts, heap sizes and per-method IL keyed by type, name and signature.

Results:
- **First run (2026-10-01, main `6c4824cbc`): not equivalent.** Stage-1 and stage-2 `GSharp.Core.dll` had identical tables and heaps but different numbering on 1,093 capture-box classes. The cause was a gsc determinism bug: lowering passes numbered synthesized types in identity-hash order ([#4663](https://github.com/DavidObando/gsharp/issues/4663)). The C#-built compiler had the same bug: adding an unrelated file renumbered its boxes. RefactoringBaselineTests passed under stage 2. All 162 `samples/` compiled to identical IL+metadata with either compiler.
- **With the #4663 fix:** `GSharp.Core.dll`, `GSharp.Cs2Gs.Translator.dll` and `GSharp.Cs2Gs.CodeModel.dll` are **byte-identical** between stage 1 and stage 2.

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
