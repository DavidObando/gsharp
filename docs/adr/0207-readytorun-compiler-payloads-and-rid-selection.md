# ADR-0207: ReadyToRun compiler payloads and RID selection

- **Status**: Proposed
- **Date**: 2026-10-22
- **Phase**: Performance
- **Issue**: [#5155](https://github.com/DavidObando/gsharp/issues/5155)
- **Related**: [#2189](https://github.com/DavidObando/gsharp/issues/2189),
  [#5126](https://github.com/DavidObando/gsharp/issues/5126) (superseded),
  [#5154](https://github.com/DavidObando/gsharp/pull/5154) (closed),
  [#5150](https://github.com/DavidObando/gsharp/pull/5150),
  [compiler architecture and performance study](../compiler-architecture-and-performance-study.md) section 4.8,
  [ADR-0200](0200-component-aware-pr-validation.md)

## Context

The published `gsc` compiles slowly at start. The study measured a hello-world
compile at 0.55 s and the Core compile at 18.7 s. ReadyToRun (R2R) images take
about 31% off the hello-world compile and about 9% off the Core compile, with
byte-identical output. Section 4.8 of the study has the probe.

PR #5154 shipped one linux-x64 R2R image at the shared `tools/compiler` path of
the `Gsharp.NET.Sdk` package. The `desktop-msbuild-sdk-smoke` job failed on
Windows with `BadImageFormatException` on `gsgen.dll`.

The cause is the PE header. crossgen2 writes the target architecture XOR an OS
tag into the PE `Machine` field. A linux-x64 image has `0xFD1D` (`0x8664` XOR
`0x7B79`). A portable IL assembly has `0x14C`. The Windows loader rejects
`0xFD1D`. The runtime does not fall back to the IL in the image. So an R2R image
works only on the OS and architecture that it targets.

Prior art agrees:

- The .NET SDK ships `csc` as R2R (`Machine` `0xFD1D` on Linux). It builds one
  SDK per OS and architecture, and runs crossgen2 on each layout in
  `src/sdk/src/Layout/redist/targets/Crossgen.targets` in `dotnet/dotnet`. It
  leaves `Microsoft.CodeAnalysis.VisualBasic.dll` as IL to save size.
- `Microsoft.Net.Compilers.Toolset` 5.0.0 is one portable package. All
  `tasks/netcore/bincore` assemblies have `Machine` `0x14C`. It has no R2R.
- The Roslyn language server publishes R2R for eight RIDs as RID-specific tool
  packages (`LanguageServerPublish.props`, `Microsoft.NET.PackTool.targets`).
- arcade runs crossgen2 per RID and skips a project when its RID is not in the
  `RuntimeIdentifiers` list (`SharedFramework.Sdk`, `Build.Tasks.Archives`).

No precedent puts RID-specific R2R inside a RID-agnostic package.

Constraints from the maintainer:

- Users keep one reference, the G# SDK (`Gsharp.NET.Sdk` in `msbuild-sdks`).
- R2R covers six RIDs: `linux-x64`, `linux-arm64`, `win-x64`, `win-arm64`,
  `osx-x64`, `osx-arm64`.
- Only `gsc` gets R2R now. `gsgen` and `gsfmt` stay IL.
- The six RIDs are expected to stay for five to ten years.

### Empirical results

These tests used a toy SDK package and a local feed on Linux (NuGet resolver
from .NET SDK 10.0.400). Scripts and packages are in `~/.cache/r2r5155/exp`.

1. **Dependencies of an SDK package are restored.** `Toy.Sdk` listed two
   dependencies (`Toy.Sdk.Tools.linux-x64`, `Toy.Sdk.Tools.win-x64`). A project
   with `Sdk="Toy.Sdk/1.0.0"` and an empty packages folder made the resolver put
   all three packages in the packages folder. The same happened with
   `msbuild-sdks` in `global.json`. The cause is in `NuGetSdkResolver.cs`
   (NuGet.Client): it calls `RestoreRunnerEx.RunWithoutCommit`, which is a real
   restore of the package with its dependencies.
2. **The SDK can find a dependency by RID.** From `$(MSBuildThisFileDirectory)`
   of the SDK, the path `../../../<id>/<version>/tools/...` exists on a cold
   cache and on a warm cache. Offline with a warm cache also works (the feed
   was unreachable).
3. **A missing dependency fails the whole SDK.** An SDK that depends on a
   package absent from the feed fails with `MSB4236` ("SDK could not be found").
   So every RID package must be on every feed before the SDK package.
4. **The meta-package downloads every RID.** The resolver restores all
   dependencies, not only the host RID. For six RIDs that is six downloads.
5. **`PackageDownload` fetches one RID.** The SDK props added
   `<PackageDownload Include="Toy.Sdk.Tools.<host rid>" Version="[1.0.0]" />`.
   `dotnet restore` of a project downloaded only the host RID package. This is
   how the .NET SDK gets crossgen2, runtime and apphost packs. Restore must run
   first, and `$(NuGetPackageRoot)` is defined only after restore.

Package sizes (zipped, from the linux-x64 probe): `gsc` and its closure is
8.2 MB, `gsfmt` 8.2 MB and `gsgen` 23.2 MB. For `gsc` only, six RIDs add about
49 MB to the registry. A host that downloads one RID adds about 8 MB.

## Decision

1. **The IL payload stays where it is.** `Gsharp.NET.Sdk` keeps `tools/compiler`,
   `tools/gsgen` and `tools/formatter` as portable IL. This is the fallback and
   the base contract.
2. **R2R `gsc` ships in six RID packages.** Package id:
   `Gsharp.NET.Sdk.Tools.<rid>` for the six RIDs above. Each has the same
   version as the SDK. Each carries `tools/compiler/` with the same file names
   as the IL layout (R2R `gsc.dll`, `GSharp.Core.dll`, the runtime assemblies
   `gsc` needs). A consumer can use the directory in place of the IL directory.
3. **How the SDK gets the RID package (recommended):** the SDK props add a
   `PackageDownload` for the host RID with the exact version `[<SDK version>]`.
   The RID is `$(NETCoreSdkPortableRuntimeIdentifier)`, which is the RID of the
   `dotnet` host that runs `gsc`. Only RIDs in the supported list are requested.
   Alternative: the SDK package lists all six RID packages as NuGet
   dependencies (result 1 above). It needs no restore step and works offline
   with one SDK download. It downloads about 49 MB more for every user.
4. **One probe selects the directory.** The MSBuild property
   `GsharpCompilerFullPath` (already in `Gsharp.NET.Sdk.props`) is the only
   place that decides. Order:
   1. A value set by the user (`GsharpCompilerFullPath`). It wins.
   2. `GsharpUseReadyToRunCompiler=false` selects the IL path.
   3. The directory `<packages>/gsharp.net.sdk.tools.<rid>/<version>/tools/compiler/`
      if `gsc.dll` is in it.
   4. The IL path `$(MSBuildThisFileDirectory)../tools/compiler/gsc.dll`.
   Other consumers (`Program.gs` driver probe, the selfhost scripts, the
   language server and the extensions) call one shared function with the same
   order. Where they run outside MSBuild, they find the SDK package directory
   first and then use the relative path `../../gsharp.net.sdk.tools.<rid>/<same
   version>/tools/compiler/`.
5. **Fallback is silent and always correct.** If the RID is not supported, the
   package is absent, or the file is missing, the IL path is used. The build
   logs one low-importance message with the reason. A missing RID package never
   fails a build.
6. **Cross-compilation.** The pack host runs crossgen2 with explicit target OS
   and architecture for each RID. A pack host needs the crossgen2 pack of its
   own RID and the runtime pack of each target RID at restore.
7. **CI verifies each RID.** An artifact-consumption smoke installs the packages
   built on the pack host on `linux-x64`, `linux-arm64`, `win-x64`, `win-arm64`,
   `osx-x64` and `osx-arm64` runners. It runs `gsc`, `gsgen` and `gsfmt` on a
   sample and compares the output hashes with the IL payload. A RID without a
   runner is listed as unverified in the release notes.

## Compatibility promise

The maintainer expects the six RIDs to stay for five to ten years. This section
lists what becomes a promise if this ADR is accepted.

### What becomes a promise

| Item | Promise |
| --- | --- |
| IL fallback | `tools/compiler` in `Gsharp.NET.Sdk` always holds a working portable `gsc`. This is the main promise. |
| Failure mode | A missing or unsupported RID package never breaks a build. It only costs speed. |
| Probe order | The four-step order in Decision 4, including `GsharpCompilerFullPath` and `GsharpUseReadyToRunCompiler`. |
| Same layout | A RID package has the same file names under `tools/compiler/` as the IL layout. |
| Version lock | A RID package has the exact version of its SDK. |
| Supported set | The six RIDs are listed in the documentation for as long as they are published. |

### What is not a promise

- Which assemblies in the RID package are R2R, and how (the crossgen2 version,
  partial or full, composite or not).
- The sizes of the packages.
- That a package for a given RID exists for a given SDK version. Consumers must
  tolerate absence.
- The location and form of `gsgen` and `gsfmt`. They stay IL for now.
- Direct references to `Gsharp.NET.Sdk.Tools.<rid>` by third parties. The ids
  are an internal detail of the SDK. The supported entry point is the SDK.

### Adding and removing a RID

- Adding a RID is additive. Older SDKs fall back to IL on that RID.
- Removing a RID changes speed only, because of the IL fallback. Do it in this
  order: announce it in the release notes, keep publishing the package for at
  least two further minor releases, then stop. Keep the id reserved so that it
  is not reused with a different meaning.
- Changing the probe order, the property names or the fallback is a breaking
  change. It needs a new ADR that supersedes this one.
- A new RID of the .NET runtime (for example `linux-riscv64`) falls back to IL
  until the maintainers add it.

### Costs of the promise

- Each release publishes seven packages (six RID packages and the SDK). The RID
  packages must reach the feed before the SDK (result 3). The publish step
  needs an ordering and a retry rule.
- The release pipeline needs crossgen2 for six RIDs and a smoke runner for each.
  Runners for `win-arm64` and `osx-x64` may not always exist. The ADR allows an
  unverified RID, but the release notes must say so.
- The runtime can change. An R2R image compiled for one major version of
  .NET may not be used by another. If the runtime rejects the image, it uses
  the JIT, and only speed is lost. This must be verified in the first
  implementation PR for the roll-forward case of the `gsc` runtimeconfig.
- The consumers (language server, VS Code and Visual Studio extensions, selfhost
  scripts) must share the probe. A copy of the probe in each consumer is a risk.
  The implementation PR adds one function and one test that fails when two
  copies disagree.

### What we can still change

- The package contents, the crossgen2 options, composite or partial R2R, and
  which assemblies are R2R.
- Whether `gsgen` and `gsfmt` get RID packages, by adding packages with the
  same pattern.
- The way the SDK gets the RID package (`PackageDownload` or dependencies),
  because consumers see only the probe result.

### What a deprecation needs

1. A release-notes entry that names the RID and the last SDK version with its
   package.
2. A message in the build log when the host RID is deprecated.
3. At least two minor releases of publishing before the stop.
4. An update of this ADR (status note) and of the documentation list.

## Consequences

Positive:

- Users keep one reference. The shared package stays portable.
- `gsc` start time drops about 31% and the Core compile about 9% on supported
  hosts, with identical output.
- The fallback makes R2R an optimization only. It cannot break a build.
- With `PackageDownload`, a user downloads one RID package (about 8 MB).

Negative:

- More packages and a stricter publish order.
- A larger release pipeline (six crossgen2 targets, six smoke runners).
- `PackageDownload` needs restore, so a flow that never restores uses IL.
- The stage-2 allowlist hashes in `build/selfhost-stage2.py` change with the Pack
  targets and must be refreshed.

Neutral:

- `gsgen` and `gsfmt` get no speedup until a follow-up.
- Lock files gain RID targets only where a project restores with a RID.

## Alternatives considered

1. **One package with RID folders** (`tools/compiler/rid/<rid>/`). One id and no
   publish ordering, but every user downloads about 49 MB more, and every RID
   change republishes the SDK. This is the fallback if per-RID packages fail in
   practice.
2. **Meta-package with dependencies on all six RID packages.** Works (results 1
   to 3). Every user downloads all six. Keep as the alternative to
   `PackageDownload`.
3. **R2R at the shared path (PR #5154).** Rejected. It breaks other OSes.
4. **Self-contained or composite R2R.** Still RID-specific, and it adds a runtime
   to the package.
5. **No R2R, only `TieredPGO=false`.** Already shipped in #5150. It gives no start
   gain.
6. **A RID-specific .NET tool package for `gsc`.** The .NET tool model installs
   with `dotnet tool`. It does not fit the MSBuild SDK flow.

## Open questions for the maintainer

1. `PackageDownload` of the host RID (recommended), or dependencies on all six?
2. Is the "internal id, not a public contract" position for the RID packages
   acceptable?
3. Is "removal needs two minor releases" the right period?
4. Which RIDs may ship unverified when a runner is missing?
