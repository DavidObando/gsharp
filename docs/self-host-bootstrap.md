# Self-host bootstrap: stage 0, stage 1, stage 2

Issue [#4631](https://github.com/DavidObando/gsharp/issues/4631). The compiler is moving to G# source.
Bootstrapping it takes three compilers:

| Stage | Compiler | Built from | Built by |
|---|---|---|---|
| 0 | C#-built `Gsharp.NET.Sdk` (today this repository's nupkg; at the cut-over the final released 0.4.x) | C# source | csc |
| 1 | stage-1 `Gsharp.NET.Sdk` | the cs2gs-migrated G# tree | stage 0 |
| 2 | the migrated tree rebuilt | the same G# tree | stage 1 |

The cut-over requires stage 2 to reproduce stage 1: `GSharp.Core.dll` and `gsc.dll` must have identical IL and
metadata (MVID zeroed), and the test suites must pass under stage 2.

## Packing stage 1

```sh
python3 build/selfhost-pack-stage1.py \
  --tree <migrated-tree> \
  --bootstrap <Gsharp.NET.Sdk.<v>.nupkg> \
  --out <dir> [--version <stage1-version>] [--work <dir>]
```

The script changes the tree in place, idempotently, and records every change in `<work>/stage1-report.json`:

- Completed pin rewrites and feed copies are appended to report-owned lists immediately, so even a later decode/write/copy failure retains earlier mutations. Expected I/O and decoding failures return an error with that partial report, not success.
- Core's generated SDK pin is rewritten last, preserving the canonical version while other projects normalize. After repairing a failed project read/write, a second prepare can finish the remaining pins without rollback or guessing a version from other projects.
- Malformed `global.json` fails with its path and JSON parse location in the report, retaining completed pin changes and leaving the invalid configuration bytes untouched. Repairing that configuration lets a later prepare proceed; unsupported non-object configuration shapes remain errors rather than being replaced.
- It stages the stage-0 nupkg and each version of `GSharp.CodeAnalysis.Analyzers.Testing` referenced by the tree into `.nugs`. Each required archive must be beside the bootstrap, under its original package ID and version; the verifier version is independent of the SDK version. Without a reference, the bootstrap-version sibling remains optional and its absence is only reported.
- Verifier references must use an unconditional `PackageReference Include` with a literal `Version` attribute or child element. Namespaced XML is supported. The preparation scan includes in-tree projects, `.props` and `.targets`; it is not an MSBuild evaluator. Updates/removals, item defaults, version overrides, central/property/range versions, unresolved item identities and conditional/target contexts fail explicitly rather than guessing a version. A self-contained migrated tree is required; references introduced only by out-of-tree imports are not certified by this scan.
- The repository's simple item aliases for unrelated packages remain supported when all their in-tree definitions identify literal package IDs. An alias that can carry the verifier, or an unresolved alias, is rejected; the script does not infer verifier versions from item definitions.
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
