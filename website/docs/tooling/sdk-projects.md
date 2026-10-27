---
title: "SDK and project files"
sidebar_position: 2
draft: false
description: "Build, run, test, and package G# projects using the Gsharp.NET.Sdk and ordinary .NET commands."
---

# SDK and project files

`Gsharp.NET.Sdk` is the MSBuild SDK that makes a `.gsproj` behave like a normal SDK-style .NET project. It layers on top of `Microsoft.NET.Sdk`, gathers `.gs` files as compile items, invokes `gsc` during `CoreCompile`, and lets `dotnet build`, `dotnet run`, and `dotnet pack` drive G# projects with familiar MSBuild properties.

## Start with a template

The `Gsharp.Templates` package provides `dotnet new` templates. The console template is the fastest path to a runnable project.

```bash
dotnet new install Gsharp.Templates::0.5.212
dotnet new gsharp-console -n MyApp
cd MyApp
dotnet build
dotnet run
```

Expected output from the template is:

```text
Hello from GSharp!
```

The template pins the `Gsharp.NET.Sdk` version into the generated project, sets `OutputType` to `Exe`, targets `net10.0`, and includes a `NuGet.config` that enables optional local SDK side-loading.

## Minimal project file

A `.gsproj` is an SDK-style MSBuild project. The SDK attribute selects G# compilation; the usual .NET properties describe the output.

```xml title="MyApp.gsproj"
<Project Sdk="Gsharp.NET.Sdk/0.5.212">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
</Project>
```

`.gs` files under the project directory are picked up automatically. Add explicit `Compile` items only for files outside the project directory; explicitly including files that the SDK already discovers can trigger the same duplicate-item errors used by the .NET SDK.

## Building and running

Use the standard .NET CLI commands.

```bash
dotnet build
dotnet run
```

During `CoreCompile`, the SDK task builds a response file and invokes `dotnet gsc.dll`. It forwards the output path, target framework, output type, version, references, warning settings, debug settings, XML documentation output, Source Link, deterministic mode, embedded-source choice, and optional reference-assembly output to `gsc`.

`OutputType` controls the compiler target. `Exe` becomes `/target:exe`; other values are treated as libraries and become `/target:library`.

### Opt-in within-project workers

`GSharpMaxWorkers` requests a total worker count between 1 and 32. It defaults
to 1; MSBuild still schedules projects. For example:

```bash
dotnet build -m:4 -p:GSharpMaxWorkers=4 -p:GSharpWorkerMemoryBudgetMiB=1024
```

Each compiler task calls `IBuildEngine9.RequestCores` once and passes the
actual grant to the compiler, including reusable worker requests. It releases
that grant when the request finishes, fails, or is cancelled. Hosts without
this interface use one worker. Compiler phases reuse the same budget, rather
than creating independent full-machine pools.

The compiler parses files independently and publishes trees in input order.
Body workers currently accept only proven primitive operations in free or
static functions, using parameters and body-owned locals. Instance-member
scopes stay coordinator-owned because their implicit receiver and inherited
pseudo-bindings need the binder's shared scope reader. Other bodies, inferred signatures and synthesis stay
on the coordinator. Diagnostics and bodies merge in their original order;
whole-program analyses run after the body barrier.

`GSharpWorkerMemoryBudgetMiB` defaults to 1024 and must be at least 256.
The concurrency calculation reserves 256 MiB and 96 MiB per worker, with
larger source/body workspaces reducing concurrency further. This bounds the
workspace concurrency estimate, **not** the entire process heap or retained
syntax/symbol graph. Processor count and the MSBuild grant also cap workers.
An input that exceeds the workspace estimate still runs sequentially; the
budget does not reject a compilation that needs its existing implicit core.
Generators use the same lease contract, but their host remains serial;
third-party generators can create their own threads.

This feature remains opt-in. A higher worker count is not a promise that
every body is independent or that every project builds faster.
Small inputs retain the measured sequential path: fewer than four files
under 64 KiB, or fewer than eight body candidates with no body reaching
8 KiB. These thresholds avoid cold scheduling and eligibility overhead.

## Target frameworks

The template defaults to `net10.0`. The SDK and compiler also support cross-targeting through MSBuild reference assemblies; `net8.0` and `net10.0` are tested end to end, and the `gsc` runtime-config mapping recognizes `net8.0`, `net9.0`, and `net10.0`.

```xml
<PropertyGroup>
  <TargetFramework>net8.0</TargetFramework>
</PropertyGroup>
```

The compiler itself is hosted on .NET 10, but it loads the project's reference assemblies through an isolated metadata context so emitted assemblies carry the target framework's BCL identities rather than the compiler host's identities.

## References

Use normal MSBuild references and package references. The SDK forwards `ReferencePathWithRefAssemblies` to `gsc` as repeated `/r:<path>` arguments, including transitive reference assemblies when MSBuild resolves them.

```xml
<ItemGroup>
  <PackageReference Include="Example.Package" Version="1.2.3" />
  <ProjectReference Include="../Shared/Shared.csproj" />
</ItemGroup>
```

## Code analyzers

`GsharpCodeAnalyzer` items load [code analyzers](./analyzers.md) into the build — extra diagnostics reported by rule assemblies, wired either directly or through an analyzer-only project reference:

```xml
<ItemGroup>
  <GsharpCodeAnalyzer Include="analyzers/MyAnalyzers.dll" />
  <ProjectReference Include="../MyAnalyzers/MyAnalyzers.gsproj"
                    OutputItemType="GsharpCodeAnalyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

Analyzer severities follow `NoWarn`/`WarningsAsErrors` and `.editorconfig` `dotnet_diagnostic.<ID>.severity` entries; see the [analyzers guide](./analyzers.md#configuring-severities).

## Debug and symbol properties

The SDK uses the standard .NET property names where possible.

| MSBuild property | Forwarded behavior |
| --- | --- |
| `DebugType` | `/debug:<value>`; `portable`, `full`, and `pdbonly` create sidecar Portable PDBs, `embedded` embeds the PDB, and `none` disables debug info. |
| `DebugSymbols` | Controls whether standard targets track and copy sidecar PDBs. |
| `PdbFile` | `/pdb:<path>`. |
| `SourceLink` | `/sourcelink:<path>`. |
| `EmbedAllSources` | `/embed+` when true. |
| `GenerateDocumentationFile` / `DocumentationFile` | `/doc:<path>` when documentation output is enabled. |
| `Deterministic` | `/deterministic+` when true. |
| `NoWarn` | `/nowarn:<ids>`. |
| `TreatWarningsAsErrors` | `/warnaserror` when true. |
| `WarningsAsErrors` | `/warnaserror+:<ids>`. |

```xml
<PropertyGroup>
  <DebugType>portable</DebugType>
  <Deterministic>true</Deterministic>
  <EmbedAllSources>false</EmbedAllSources>
</PropertyGroup>
```

### Source Link

The .NET SDK supplies Source Link generation for supported Git hosts. G# writes the generated mapping into portable or embedded PDBs. No additional package is necessary for the standard providers.

Use these properties for a library that you intend to publish:

```xml
<PropertyGroup>
  <DebugType>portable</DebugType>
  <Deterministic>true</Deterministic>
  <PublishRepositoryUrl>true</PublishRepositoryUrl>
  <IncludeSymbols>true</IncludeSymbols>
  <SymbolPackageFormat>snupkg</SymbolPackageFormat>
</PropertyGroup>
```

Build from a Git checkout with the intended remote URL. Publish the referenced commit before you publish the package. Use `dotnet pack` to produce the package and its symbol package.

The package manifest records the repository URL and commit. The PDB maps source documents to commit-specific URLs. Incremental builds update the PDB when the mapping changes.

Set `EnableSourceLink=false` to disable automatic mapping generation. A local repository without remote metadata still produces ordinary debug symbols. Source Link does not upload files or embed source bytes.

For an explicit mapping, disable automatic generation and set `SourceLink` to your JSON file:

```xml
<PropertyGroup>
  <EnableSourceLink>false</EnableSourceLink>
  <SourceLink>sourcelink.json</SourceLink>
</PropertyGroup>
```

The SDK reports an error if this file is missing and compilation requests debug information. The compiler preserves the JSON bytes. The mapping must match the absolute document paths in the PDB.

Source embedding remains a separate `EmbedAllSources` option. G# does not implement selective embedding through `EmbedUntrackedSources`. Do not enable source embedding unless you intend to distribute those source files.

See the [Microsoft guidance](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/sourcelink) and the [Source Link documentation](https://github.com/dotnet/sourcelink#using-source-link-in-net-projects).

## Generated sources: resx and Roslyn generators

The 0.4 SDK has two build-time generated-source paths.

### `.resx` codebehind

A `.resx` file can be paired with a generated `{BaseName}.Designer.gs` accessor class. The shared `GSharp.Core.Resx` generator parses the resource XML, maps CLR resource types to G# type clauses, sanitizes resource keys into valid identifiers, and emits a `ResourceManager` / `Culture` pair plus one property per resource. The namespace is the project `RootNamespace` plus the folder path under the project root.

This currently solves the compile-time codebehind problem. Embedding `.resources` into the final assembly is not part of this generator yet, so runtime `ResourceManager` lookup still depends on future SDK resource-embedding work.

### `gsgen` source-generator host

For native `.gsproj` projects, `gsgen` hosts Roslyn source generators outside `gsc`, keeping Roslyn out of the compiler emit path. The SDK:

1. re-resolves C# analyzer assets from package references into `@(GsharpAnalyzer)`;
2. forwards `@(AdditionalFiles)` and selected project properties such as `RootNamespace`, `ProjectDir`, and Avalonia name-generator settings;
3. runs `gsgen` before `CoreCompile` when analyzers or stray `.cs` compile items are present;
4. writes deterministic `.g.gs` files under `obj\gsgen\`; and
5. adds those generated files to `@(Compile)` before invoking `gsc`.

`GsharpRunSourceGenerators=false` disables this pass. `GsgenToolFullPath` overrides the tool path. A project without analyzer paths or foreign C# files skips the launch, unless an earlier manifest needs orphan cleanup. Analyzer assemblies without actual generators do not trigger G# parsing, reference setup, or stub projection.

`gsgen` projects G# declarations to C# stubs, runs the real Roslyn generators, translates generated C# back to G#, and emits partial `.g.gs` parts. This is the path used by source generators in migrated projects too: `cs2gs` preserves generator inputs rather than freezing generated output.

An empty manifest does not skip future generator execution. Generators can report diagnostics without producing source, or produce new source after changes to declarations, references, options, additional files, or generator assemblies. Generated partials still participate in the final `gsc` compilation; the host's pre-generator declaration scope is not reused as the final scope.

Set `GSHARP_MEASURE_PHASES` to a JSON file path to record opt-in host phases without changing diagnostic output. Use `{pid}` and `{id}` in the path to separate processes and requests. Reports include discovery, metadata and reference setup, source loading, projection, execution, translation, and output. Nested process-inclusive phase durations are not additive.

`GSharpUseSharedCompilation=true` opts `GsgenTask` into one serial generator worker per MSBuild node and build. The default remains one-shot execution. Each request loads fresh generator instances in collectible package contexts and runs a new driver. Only content-hashed immutable metadata images and host code are reused; previous generator output is never a cache key. The cache caps stored input images at 128 MiB and 512 entries, excluding Roslyn's metadata indexes and object overhead.

Workers retire after 16 requests, 60 seconds idle, 256 MiB retained managed memory, or 1 GiB working set. These are post-request retirement limits, not limits on an active compilation's peak memory. A worker also retires if an analyzer context cannot unload, a generator leaves helper processes running, a request or finalizer changes Console channels or encodings, or generation used the host's implicit G# reference surface rather than an explicit reference closure. Normal retirement, MSBuild cancellation, and owner disconnection terminate the worker's owned process tree; the next request starts a fresh host. Startup failures or rejected requests explicitly fall back to one-shot execution. A dispatched request is never retried after transport loss.

Worker responses use a private named pipe, separate from diagnostic stdout and stderr. The SDK captures both diagnostic streams, including output inherited by generator helper processes, and drains request completion fences before reporting completion. The completion packet carries the compilation result; a retired worker's OS exit code is not that result.

Failed or interrupted requests stop the owned worker and drain bounded diagnostic lines and unfinished tails without retrying. Pre-acceptance output is startup information, so permitted fallback does not turn it into a compiler error. Worker startup passes typed arguments, preserving supported spaces, Unicode, and quotes in tool and pipe paths.

Removing the final source and analyzer still clears an existing manifest and deletes its generated parts before they can be added back to compilation. This source-free cleanup does not bypass source validation when generators or foreign C# translation are requested.

The manifest records owned files, not task success. The SDK stages each request's files and manifest privately, then publishes changes and removes orphans only after the tool exit status and diagnostic streams pass validation. Diagnostic failures preserve the previous generated files and manifest, including their timestamps. The SDK removes `gsgen.manifest.success` before an attempt and commits it after publication. Errors written directly to stdout or stderr therefore remain visible on unchanged rebuilds until corrected; successful builds return to normal no-op behavior.

A generator that implements a partial method, such as the Regex generator, pairs with a G# declaring part. Write a static one inside a `shared` block; `private shared partial func` is not valid G#:

```gsharp
partial class Patterns {
    shared {
        @GeneratedRegex("\\d+", RegexOptions.IgnoreCase)
        private partial func Digits() Regex;
    }
}
```

`cs2gs migrate` translates a C# `[GeneratedRegex]` partial method to exactly this declaring part, with the pattern, options, match timeout and culture name re-spelled as literals, and drops the generated C# implementation. A C# `partial record` or `partial record struct` becomes a G# `partial data class` or `partial data struct` and keeps the declaring part. It reports the shapes G# cannot pair with a generated implementing part: a method declared in a nested type, and the `[GeneratedRegex]` partial-property form (use the method form instead).

`gsgen` writes the generated body as an implementing part (`partial func` with a body) spelled with your declaring part's header, so a signature spelled differently from the generated C# still pairs: `System.Text.RegularExpressions.Regex` or `Regex`, `int` or `int32`. Two limits apply:
- overloads with the same name and parameter count in one type keep the generated spelling, so spell those the way the generated code does;
- parameter names must match the generator's, which normally copies them from your declaration. A mismatch is reported as `GS9208`. The generator's helper types stay in their own package, `System.Text.RegularExpressions.Generated` for the Regex generator, so they cannot collide with your types. See [`samples/GeneratedRegex`](https://github.com/DavidObando/gsharp/tree/main/samples/GeneratedRegex).

Stray `.cs` `Compile` items produced by other MSBuild targets are partitioned out before `gsc` sees them and are translated through the same `gsgen` pipeline.

## Libraries and packages

Use `OutputType` `Library` for reusable assemblies.

```xml title="MyLibrary.gsproj"
<Project Sdk="Gsharp.NET.Sdk/0.5.212">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyLibrary</RootNamespace>
    <PackageId>MyLibrary</PackageId>
    <Authors>GSharp Authors</Authors>
    <Description>A G# library consumable from other .NET languages.</Description>
  </PropertyGroup>
</Project>
```

When `ProduceReferenceAssembly` is true, the SDK asks `gsc` for `/refout:<path>` and contributes the resulting reference assembly to NuGet pack under `ref/<tfm>/`. The runtime assembly is handled by the standard SDK under `lib/<tfm>/`.

```bash
dotnet pack -c Release
```

The SDK defaults `IncludeSymbols` to the evaluated `IncludeBuildOutput` value during normal project imports.
The default symbol-package format is `snupkg`.
For content-only packages, set `IncludeBuildOutput` to `false`; the SDK then leaves symbol packaging disabled by default.
An explicit `IncludeSymbols` value takes precedence. Set it to `false` to omit symbols from a library package,
or to `true` when a content-only package supplies its own symbol files. `SymbolPackageFormat` remains configurable.
It selects the format only when `IncludeSymbols` is `true`; it does not enable symbol packaging.
These properties configure NuGet packing (`dotnet pack`), not PDB generation during builds.

## Multiple packages in one project

G# `package` declarations map to CLR namespaces, not to MSBuild projects. One `.gsproj` produces one assembly, and that assembly may contain multiple G# packages/namespaces. This matches C# projects, where a single assembly can contain many namespaces.

```gsharp title="Core.gs"
package MyApp.Core

func Answer() int32 {
  return 42
}
```

```gsharp title="Cli.gs"
package MyApp.Cli

import System
import MyApp.Core

Console.WriteLine(Answer())
```

Top-level statements choose the entry-point package. The single-package case remains the simplest and most common layout.

## Local SDK side-loading

`Gsharp.NET.Sdk` and `Gsharp.Templates` are published on NuGet, so projects resolve the SDK from the public feed by default. Projects can also resolve packed `.nupkg` files from a local feed, for example to test an SDK build that is not on NuGet. The template scaffolds a `NuGet.config` for this.

```bash
mkdir -p packages
cp /path/to/Gsharp.NET.Sdk.<version>.nupkg packages/
dotnet build
```

The examples above pin the SDK directly in `Sdk="Gsharp.NET.Sdk/0.5.212"`, so they work outside this repository. Alternatively, use the unversioned `Sdk="Gsharp.NET.Sdk"` with an adjacent `global.json`:

```json title="global.json"
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "0.5.212"
  }
}
```
