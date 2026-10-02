# Self-host bootstrap: stage 0, stage 1, stage 2

Issue [#4631](https://github.com/DavidObando/gsharp/issues/4631). The compiler is moving to G# source.
Bootstrapping it takes three compilers:

| Stage | Compiler | Built from | Built by |
|---|---|---|---|
| 0 | C#-built `Gsharp.NET.Sdk` (today this repository's nupkg; at the cut-over the final released 0.4.x) | C# source | csc |
| 1 | stage-1 `Gsharp.NET.Sdk` | the cs2gs-migrated G# tree | stage 0 |
| 2 | the migrated tree rebuilt | the same G# tree | stage 1 |

The cut-over requires stage 2 to reproduce stage 1: `GSharp.Core.dll` and `gsc.dll` must have identical method
bodies, CLR execution flags/entry point and metadata (MVID zeroed), and the test suites must pass under stage 2.

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
- It builds the projects twice in the **same tree path**: first pinned to stage 0 (which yields the stage-1 assemblies), then pinned to stage 1 (which yields the stage-2 assemblies). Each stage gets its own isolated package cache, cleared before that stage's build even when `--work` is reused. The stage-2 cache is retained for tests. Assembly snapshots have independent stage-local filenames even for parent-relative or absolute output paths. `--work` must be outside the migrated tree's `out` directory, which each build deletes.
- For each assembly pair it compares the full-file SHA-256 and the IL+metadata hash with the MVID zeroed. `build/selfhost/PeContentHash.cs` includes **complete method bodies** (headers, IL and exception regions) and the **CLR execution flags and entry point**, unlike the existing IL-only RefactoringBaselineTests body hash, which is unchanged. Timestamps, checksums and debug-wrapper data remain excluded.
- Test projects run while pinned to stage 1, so everything they compile against is a stage-2 assembly. Every requested run must exit zero and produce fresh TRX evidence of a positive number of executed, passing tests. Missing, malformed, stale or zero-test evidence fails the gate. Each request has a separate results directory under `--work`; multiple target-framework TRX files are all checked.
- Default assembly outputs follow `--config` (Release by default); explicit `--assembly` paths are used unchanged.
- The verdict is "equivalent" only when every IL+metadata hash matches. A full-file difference with matching IL+metadata is reported, not hidden.
- `build/selfhost/PeDiff.cs` explains a difference: it compares table row counts, heap sizes and per-method IL keyed by type, name and signature.

Results:
- **First run (2026-10-01, main `6c4824cbc`): not equivalent.** Stage-1 and stage-2 `GSharp.Core.dll` had identical tables and heaps but different numbering on 1,093 capture-box classes. The cause was a gsc determinism bug: lowering passes numbered synthesized types in identity-hash order ([#4663](https://github.com/DavidObando/gsharp/issues/4663)). The C#-built compiler had the same bug: adding an unrelated file renumbered its boxes. RefactoringBaselineTests passed under stage 2. All 162 `samples/` compiled to identical IL+metadata with either compiler.
- **With the #4663 fix:** `GSharp.Core.dll`, `GSharp.Cs2Gs.Translator.dll` and `GSharp.Cs2Gs.CodeModel.dll` are **byte-identical** between stage 1 and stage 2.
