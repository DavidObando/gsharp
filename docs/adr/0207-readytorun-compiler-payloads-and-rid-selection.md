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

6. **A missing RID package fails restore.** `Toy.Sdk` 4.0.0 added a
   `PackageDownload` for `[4.0.0]` of the host RID package. The package was in
   neither the feed nor the cache. `dotnet restore` failed with `NU1102` ("Unable
   to find package ... with version (= 4.0.0)"). A `dotnet build --no-restore`
   after it failed with the same error from the assets file. With an opt-out
   property that removed the `PackageDownload`, both restore and build
   succeeded. So the opt-out must be set for restore and for build. A failed
   acquisition is fatal, not a fallback.

Package sizes (zipped, from the linux-x64 probe): `gsc` and its closure is
8.2 MB, `gsfmt` 8.2 MB and `gsgen` 23.2 MB. For `gsc` only, six RIDs add about
49 MB to the registry. A host that downloads one RID adds about 8 MB.

## Decision

1. **The IL payload stays where it is.** `Gsharp.NET.Sdk` keeps `tools/compiler`,
   `tools/gsgen` and `tools/formatter` as portable IL. This is the fallback and
   the base contract.
2. **R2R `gsc` ships in six RID packages.** The package id is
   `Gsharp.NET.Sdk.Compiler.<rid>` for `linux-x64`, `linux-arm64`, `win-x64`,
   `win-arm64`, `osx-x64` and `osx-arm64`. Each package has the version of its
   SDK. Section "Naming and layout" gives the reasons for the names.
3. **The SDK gets the host RID package with `PackageDownload`.** The SDK adds a
   `PackageDownload` item for the RID of the `dotnet` host that runs `gsc` (see
   "Launch host" below for how that host is found). The RID is not read from
   the SDK property alone. The version is the exact range
   `[<SDK version>]`. The SDK adds it only when the launch-host RID is exactly one of
   the six RIDs in `GsharpCompilerRuntimeIdentifiers`. For any other host
   (`linux-musl-x64`, `win-x86`, `linux-arm`, the BSDs, and so on) the SDK adds
   no `PackageDownload` and uses the IL payload, so restore never asks for a
   package that does not exist. Result 6 shows that a failed acquisition is
   fatal, so the guard is the only protection for those hosts. The opt-out `GsharpUseReadyToRunCompiler=false`
   also adds no `PackageDownload`. A user can then restore offline, or against a
   mirror that lacks the RID packages. A NuGet dependency meta-package is
   rejected (see Alternatives).
4. **One probe selects the directory.** The MSBuild property
   `GsharpCompilerFullPath` (already in `Gsharp.NET.Sdk.props`) is the only place
   that decides. Order:
   1. A value set by the user (`GsharpCompilerFullPath`). It wins.
   2. `GsharpUseReadyToRunCompiler=false` selects the IL path.
   3. If the launch host is unknown or its RID is not the RID of the package
      (see "Launch host"), select the IL path.
   4. The file `tools/<tfm>/<rid>/gsc.dll` inside the RID package in the NuGet
      packages folder, if the file exists.
   5. The IL path `$(MSBuildThisFileDirectory)../tools/compiler/gsc.dll`.
   Other consumers (`Program.gs` driver probe, the selfhost scripts, the
   language server and the extensions) call one shared function with the same
   order. Outside MSBuild, they find the packages folder of the SDK package and
   use the id and version rule in "Naming and layout".
5. **Fallback is silent and always correct at build time.** If the RID is not
   supported, the opt-out is set, or the file is missing from the package
   directory, the IL path is used. The build logs one low-importance message
   with the reason. The failure rules are:
   - For a host outside the six RIDs, nothing is requested, so nothing can fail.
   - For a host in the six RIDs, a missing package at the exact SDK version makes
     restore fail, because NuGet cannot find the version that `PackageDownload`
     names. The release process must prevent this (see "Costs of the promise").
   - With `GsharpUseReadyToRunCompiler=false`, nothing is requested and nothing
     can fail.
6. **Cross-compilation.** The pack host runs crossgen2 with explicit target OS
   and architecture for each RID. A pack host needs the crossgen2 pack of its
   own RID and the runtime pack of each target RID at restore.
7. **CI verifies all six RIDs.** An artifact-consumption smoke runs on all six
   RIDs (see "CI plan"). A RID that was not verified in a given release is
   named in the release notes of that release.

### Launch host

Acquisition, selection and launch must use the same executable. The R2R image
works only with a host of its own OS and architecture.

`$(NETCoreSdkPortableRuntimeIdentifier)` names the selected SDK installation. It
is not the program that launches `gsc`. Today all launchers start the bare name
`dotnet` and use `PATH`: `BuildTask.gs` (the compile), `GsgenTask.gs`
(`gsgen`), `WorkerProcessClient.gs` (the worker) and the `Program.gs` driver
(`gsgen`). Nothing uses `DOTNET_HOST_PATH`. The language server and the editor
extensions do not start `gsc`. So an x64 SDK that runs on an arm64 machine can
select the x64 pack while `PATH` starts an arm64 `dotnet`.

The rule:

1. **The launch host is `$(DOTNET_HOST_PATH)`.** The `dotnet` CLI sets it for
   the build. It is the host that runs MSBuild and the SDK. A new shared
   launcher function starts `gsc`, the worker and `gsgen` with that exact path.
   If it is not set (for example Visual Studio with .NET Framework MSBuild), the
   launch host is unknown. Then the probe selects the IL path, and the launcher
   keeps the current `dotnet` from `PATH`.
2. **The host RID is the RID of the build process.** The task runs inside the
   host process, so `RuntimeInformation.RuntimeIdentifier` (as a portable RID)
   is the RID of `$(DOTNET_HOST_PATH)`. The SDK props use the same value when
   they add the `PackageDownload`, and not the SDK property alone. A task that
   runs in another kind of process (for example .NET Framework MSBuild) has no
   usable host RID and selects IL.
3. **A mismatch falls back to IL.** At launch, the task compares the host RID
   with the RID of the selected package. If they differ, it uses the IL path and
   logs a message. This guards the case where the restore ran with one host and
   the build runs with another.
4. **One implementation.** The probe and the launcher are one function. The
   language server, the extensions and the selfhost scripts that need to start
   `gsc` call it, or use the IL path.

The implementation PR must add a test that fails if a launcher starts `dotnet`
from `PATH` while the selected path is an R2R image.

### Naming and layout

The names follow the .NET SDK and Roslyn conventions. These are the sources:

| Convention | Source |
| --- | --- |
| A pack id is a base identity plus `.<rid>`: `Microsoft.NETCore.App.Crossgen2.<rid>`, `Microsoft.NETCore.App.Host.<rid>`, `Microsoft.NETCore.App.Runtime.<rid>`. | `KnownCrossgen2Pack` and `KnownAppHostPack` in `src/Layout/redist/targets/GenerateBundledVersions.targets` (`dotnet/sdk`): `Crossgen2PackNamePattern="Microsoft.NETCore.App.Crossgen2.**RID**"`, `AppHostPackNamePattern="Microsoft.NETCore.App.Host.**RID**"`. |
| Known packs are items with the base identity as `Include`, a `TargetFramework`, a name pattern, a version and a RID list (`Crossgen2PackVersion`, `Crossgen2RuntimeIdentifiers`). | Same file. |
| The SDK turns a known pack into a `PackageDownload` item with a `Version` metadata for the host RID. | `ProcessFrameworkReferences.cs` (`packagesToDownload.Add`, `AddToolPack`), `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` (target runs before `CollectPackageDownloads`). |
| A RID-specific .NET tool package has the id `$(PackageId).$(RuntimeIdentifier)`, the package type `DotnetToolRidPackage` and the layout `tools/<tfm>/<rid>/`. | `Microsoft.NET.PackTool.targets` (`dotnet/sdk`): `<PackageId>$(PackageId).$(RuntimeIdentifier)</PackageId>`, `PackagePath` `tools/$(_ToolPackShortTargetFrameworkName)/$(_ToolRidPath)/`. |
| Roslyn publishes its language server for eight RIDs with `RuntimeIdentifiers`, `SelfContained=false` and `PublishReadyToRun=true`. | `src/LanguageServer/LanguageServerPublish.props` (`dotnet/roslyn`). |

The G# choices:

- **Package id**: `Gsharp.NET.Sdk.Compiler.<rid>`. The base identity names the
  content (`Compiler`, like `Crossgen2` in the .NET id), and the prefix
  `Gsharp.NET.Sdk.` keeps the ownership of the id with the SDK. An earlier idea,
  `Gsharp.NET.Sdk.Tools.<rid>`, named the folder and not the content, so it was
  dropped. `gsgen` and `gsfmt` can get `Gsharp.NET.Sdk.Gsgen.<rid>` and
  `Gsharp.NET.Sdk.Formatter.<rid>` later.
- **Layout inside the package**: `tools/<tfm>/<rid>/` with the same flat file
  names as `tools/compiler/` in the SDK package (`gsc.dll`, `GSharp.Core.dll`,
  and the other files that `gsc` needs). The `<tfm>` is
  `$(GsharpCompilerPackageTargetFramework)` (`net10.0` now). It records the
  runtime band that the R2R code was compiled for. This is the
  `DotnetToolRidPackage` layout.
- **Package type**: the default (`Dependency`). The pack is not a .NET tool and
  `dotnet tool install` must not accept it.
- **MSBuild items** (mirror of `KnownCrossgen2Pack`): `KnownGsharpCompilerPack`
  with `Include="Gsharp.NET.Sdk.Compiler"`, `TargetFramework`,
  `GsharpCompilerPackNamePattern="Gsharp.NET.Sdk.Compiler.**RID**"`,
  `GsharpCompilerPackVersion` (the SDK version) and
  `GsharpCompilerRuntimeIdentifiers` (the six RIDs). A target that runs before
  `CollectPackageDownloads` adds the `PackageDownload`. The resolved pack is the
  item `GsharpCompilerPack` with the metadata `PackageDirectory`.
- **Properties**: `GsharpCompilerFullPath` is unchanged (existing public
  property). `GsharpUseReadyToRunCompiler` is the opt-out, in the style of
  `UseAppHost`.
- **Version range**: exact, `[<version>]`. The .NET packs are pinned the same
  way, with one version for each pack set.

Deviations, with reasons:

- The .NET SDK maps the host RID to the best pack RID through the RID graph
  (`NuGetUtils.GetBestMatchingRid`). The first G# release matches the exact
  portable host RID against the allowlist of six. A host such as
  `linux-musl-x64` is not in the list and uses IL. RID-graph matching can be
  added later as a speedup that does not break anything. It needs a check first:
  it is untested whether an image tagged for `linux` loads on musl, so the
  implementation must verify it before it maps a RID to a package.
- The .NET packs ship a runtime, so their RID is a runtime RID. Our packs ship
  code for `dotnet gsc.dll`, so only the host RID of the `dotnet` process counts.
- The RID package is not a .NET tool, so it has no `DotnetToolSettings.xml`
  file and no `DotnetToolRidPackage` package type.

### CI plan

The smoke job installs the packages that the pack host built, then runs `gsc`,
`gsgen` and `gsfmt` on a sample, and compares the output hashes with the IL
payload. It runs on all six RIDs. The first RID package check also confirms that
`PackageDownload` fetched the matching RID.

The runner labels that this repository already uses are `ubuntu-latest`,
`windows-latest`, `macos-latest` and `macos-26`. The `DavidObando/Oahu`
workflow `build-clients.yml` builds all six RIDs, but it does not run the
cross-built ones. It uses `ubuntu-latest` for `linux-x64` and `linux-arm64`,
`macos-latest` for `osx-arm64` and `osx-x64`, and `windows-latest` for `win-x64`
and `win-arm64`. So that file shows the build side only. Running a RID needs a
runner of that architecture:

| RID | Runner label | Note |
| --- | --- | --- |
| `linux-x64` | `ubuntu-latest` | Hosted runner. Also the pack host. |
| `linux-arm64` | `ubuntu-24.04-arm` | Hosted arm64 runner. Free for public repositories. |
| `win-x64` | `windows-latest` | Hosted runner. |
| `win-arm64` | `windows-11-arm` | Hosted arm64 runner. Free for public repositories. |
| `osx-arm64` | `macos-latest` | Hosted arm64 runner. |
| `osx-x64` | An Intel macOS label, for example `macos-15-intel` | Hosted. Intel images are being retired. If the label disappears, fall back to Rosetta on `macos-latest`: install the x64 .NET and run with `arch -x86_64`. |

The arm64 labels and the Intel macOS label come from the GitHub-hosted runner
documentation. They were not read from a workflow in this repository, so the
implementation PR must confirm each label before it relies on it. Arm64 runners
are free for public repositories. For a private repository they are billed as
larger runners. Hosted runners can have a long queue time. A smoke job that
cannot get a runner must not block the release, so the release notes name the
unverified RID (see the compatibility section).

## Compatibility promise

The maintainer expects the six RIDs to stay for five to ten years. This section
lists what becomes a promise if this ADR is accepted.

### What becomes a promise

| Item | Promise |
| --- | --- |
| IL fallback | `tools/compiler` in `Gsharp.NET.Sdk` always holds a working portable `gsc`. This is the main promise. |
| Failure mode | A host outside the six RIDs, or a build with `GsharpUseReadyToRunCompiler=false`, never requests a RID package and cannot fail. On the six RIDs, a missing package at the exact SDK version fails restore, and the release process prevents it. After restore, a missing file only costs speed. |
| Probe order | The five-step order in Decision 4, including `GsharpCompilerFullPath`, `GsharpUseReadyToRunCompiler` and the launch-host check. |
| Launch host | `gsc` starts with `$(DOTNET_HOST_PATH)`. An R2R image is used only when the host RID equals the package RID. A mismatch uses IL. |
| Same layout | A RID package has the same file names under `tools/<tfm>/<rid>/` as the IL layout under `tools/compiler/`. |
| Version lock | A RID package has the exact version of its SDK. |
| Supported set | The six RIDs are listed in the documentation for as long as they are published. |

### What is not a promise

- Which assemblies in the RID package are R2R, and how (the crossgen2 version,
  partial or full, composite or not).
- The sizes of the packages.
- That a package for a given RID exists for a given SDK version. Consumers must
  tolerate absence.
- The location and form of `gsgen` and `gsfmt`. They stay IL for now.
- Direct references to `Gsharp.NET.Sdk.Compiler.<rid>` by third parties. The ids
  are an internal detail of the SDK, but they follow the .NET naming convention.
  The supported entry point is the SDK.

### Adding and removing a RID

- Adding a RID is additive. Older SDKs fall back to IL on that RID.
- Removing or deprecating a RID needs a major release of G#. A minor release
  never removes a RID. Removal changes speed only, because of the IL fallback,
  but the policy is still a major release. Before that major release, the
  previous release must announce the removal in its release notes and must log a
  message in the build when the host RID is deprecated. Keep the id reserved so
  that it is not reused with a different meaning.
- Changing the probe order, the property names or the fallback is a breaking
  change. It needs a new ADR that supersedes this one.
- A new RID of the .NET runtime (for example `linux-riscv64`) falls back to IL
  until the maintainers add it.

### Costs of the promise

- Each release publishes seven packages (six RID packages and the SDK). Because
  a missing RID package fails restore on that RID, the publish step must:
  1. publish the six RID packages first, and the SDK package last;
  2. retry a failed push of any package, and never publish the SDK if one RID
     package failed;
  3. run a post-publish check that all six `Gsharp.NET.Sdk.Compiler.<rid>`
     packages exist on the feed at the exact SDK version (a restore of a probe
     project on each RID, or a feed query), and mark the release failed if one
     is missing.
- The release pipeline needs crossgen2 for six RIDs and a smoke job for each.
  Any RID may ship unverified, but the team always tries to verify all six. The
  release notes of a release name each RID that the smoke did not verify.
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
- The mechanism that puts the RID package in the packages folder, because
  consumers see only the probe result.

### What a deprecation needs

1. A major release of G# for the removal itself.
2. In the release before it, a release-notes entry that names the RID and the
   last SDK version that has its package.
3. In the same release, a message in the build log when the host RID is
   deprecated.
4. An update of this ADR (status note) and of the documentation list.

## Consequences

Positive:

- Users keep one reference. The shared package stays portable.
- `gsc` start time drops about 31% and the Core compile about 9% on supported
  hosts, with identical output.
- After a successful restore, R2R is an optimization only. A missing file, an unsupported host or an unknown launch host uses IL.
- With `PackageDownload`, a user downloads one RID package (about 8 MB).

Negative:

- More packages and a stricter publish order.
- A larger release pipeline (six crossgen2 targets, six smoke runners).
- `PackageDownload` is a required restore input. On the six RIDs, a missing package at the exact SDK version fails restore, and the release process must prevent it.
- `PackageDownload` needs restore, so a flow that never restores uses IL.
- All launchers must use one host path (`DOTNET_HOST_PATH`), which changes four call sites.
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
2. **Meta-package with NuGet dependencies on all six RID packages (rejected).**
   The tests show that it works: the resolver restores the dependencies into
   the packages folder (results 1 and 2), and the SDK finds them by a relative
   path. It was rejected for three reasons. Every user downloads all six RIDs
   (result 4). A missing dependency makes the whole SDK fail with MSB4236
   (result 3), which is a harder failure than a missing `PackageDownload`. And
   it does not follow the .NET convention for RID-specific packs (result 5).
3. **R2R at the shared path (PR #5154).** Rejected. It breaks other OSes.
4. **Self-contained or composite R2R.** Still RID-specific, and it adds a runtime
   to the package.
5. **No R2R, only `TieredPGO=false`.** Already shipped in #5150. It gives no start
   gain.
6. **A RID-specific .NET tool package for `gsc`** (`DotnetToolRidPackage`). The
   .NET tool model installs with `dotnet tool`. It does not fit the MSBuild SDK
   flow. G# copies its id and folder conventions only.

## Open questions

The maintainer decided these points on 2026-10-22: `PackageDownload` of the host
RID, internal RID package ids that follow the .NET conventions, removal of a RID
only in a major release, and verification of all six RIDs with any RID allowed to
ship unverified.

No question remains open. The maintainer fixed two more points on 2026-10-22:
the base name is `Gsharp.NET.Sdk.Compiler.<rid>`, and the first release matches
the exact portable RID against an allowlist of six. RID-graph matching is a
future, additive speedup. It needs a check of musl first (see "Naming and
layout").
