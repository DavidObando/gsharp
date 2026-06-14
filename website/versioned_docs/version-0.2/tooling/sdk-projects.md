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

During `CoreCompile`, the SDK task builds a response file and invokes `dotnet gsc.dll`. It forwards the output path, target framework, output type, version, references, warning settings, debug settings, Source Link, deterministic mode, embedded-source choice, and optional reference-assembly output to `gsc`.

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

G# `package` declarations map to CLR namespaces, not to MSBuild projects. ADR-0028 selected the .NET-friendly model: one `.gsproj` produces one assembly, and that assembly may contain multiple G# packages/namespaces. This matches C# projects, where a single assembly can contain many namespaces.

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
