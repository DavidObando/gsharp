---
title: "SDK and project files"
sidebar_position: 2
draft: false
---

# SDK and project files

`Gsharp.NET.Sdk` is the MSBuild SDK that makes a `.gsproj` behave like a normal SDK-style .NET project. It layers on top of `Microsoft.NET.Sdk`, gathers `.gs` files as compile items, invokes `gsc` during `CoreCompile`, and lets `dotnet build`, `dotnet run`, and `dotnet pack` drive G# projects with familiar MSBuild properties.

## Start with a template

The `Gsharp.Templates` package provides `dotnet new` templates. The console template is the fastest path to a runnable project.

```bash
dotnet new install Gsharp.Templates
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
<Project Sdk="Gsharp.NET.Sdk">
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

## Target frameworks

The template defaults to `net10.0`. The SDK and compiler also support cross-targeting through MSBuild reference assemblies; repository end-to-end coverage currently exercises `net8.0` and `net10.0`, and the `gsc` runtime-config mapping recognizes `net8.0`, `net9.0`, and `net10.0`.

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

## Generated sources: resx and Roslyn generators

The 0.3 SDK has two build-time generated-source paths.

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

`GsharpRunSourceGenerators=false` disables this pass. `GsgenToolFullPath` overrides the tool path. The common no-generator project pays only the analyzer-resolution check and skips the actual `gsgen` launch.

`gsgen` projects G# declarations to C# stubs, runs the real Roslyn generators, translates generated C# back to G#, and emits partial `.g.gs` parts. This is the path used by source generators in migrated projects too: `cs2gs` preserves generator inputs rather than freezing generated output.

Stray `.cs` `Compile` items produced by other MSBuild targets are partitioned out before `gsc` sees them and are translated through the same `gsgen` pipeline.

## Libraries and packages

Use `OutputType` `Library` for reusable assemblies.

```xml title="MyLibrary.gsproj"
<Project Sdk="Gsharp.NET.Sdk">
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

`Gsharp.NET.Sdk` and `Gsharp.Templates` are published on NuGet, so projects resolve the SDK from the public feed by default. When you are developing the SDK itself, projects can instead resolve packed `.nupkg` files from a local feed. The template scaffolds a `NuGet.config` for this workflow.

```bash
mkdir -p packages
cp /path/to/Gsharp.NET.Sdk.<version>.nupkg packages/
dotnet build
```

You can also pin an SDK version through `global.json` next to the project.

```json title="global.json"
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "0.1.105-g627f5152b0"
  }
}
```
