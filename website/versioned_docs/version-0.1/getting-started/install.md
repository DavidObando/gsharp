---
title: "Install G#"
sidebar_position: 1
draft: false
---

# Install G#

G# projects build with the normal .NET tools. The recommended path is to use the MSBuild SDK and project template; compiler developers can also build `gsc` from source.

## Prerequisites

Install a .NET runtime and SDK that can run the G# compiler and build SDK-style projects. The bundled compiler currently runs as a `net10.0` tool, and emitted executable runtime configs default to `net10.0` unless you pass `/targetframework` or `/tfm`. The compiler's runtime mapping also recognizes `net8.0` and `net9.0`.

For SDK projects, `Gsharp.NET.Sdk` handles `.gs` files during `dotnet build`. The SDK usage tests cover `net8.0` and `net10.0`, and the compiler can emit for `net8.0`, `net9.0`, or `net10.0` when the matching reference assemblies are supplied by the project build.

Verify your .NET installation with:

```bash
dotnet --info
```

## Start with the project template

The fastest path is the `Gsharp.Templates` package. It scaffolds a console app that uses `Gsharp.NET.Sdk` and can be built and run like any other .NET project.

```bash
dotnet new install Gsharp.Templates
dotnet new gsharp-console -n MyApp
cd MyApp && dotnet build && dotnet run
# -> Hello from GSharp!
```

The generated project includes a `.gsproj`, a starter `Program.gs`, a `NuGet.config` for local SDK side-loading while packages are not yet on a public feed, and a README.

## Author a project by hand

A minimal project file looks like this:

```xml title="HelloWorld.gsproj"
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>HelloWorld</RootNamespace>
  </PropertyGroup>
</Project>
```

The SDK automatically includes `.gs` files in the project directory, forwards references and build settings to `gsc`, and supports regular commands such as:

```bash
dotnet build
dotnet run
```

If you need to side-load a locally packed SDK, copy the package into the project's configured package source before building:

```bash
mkdir -p packages
cp /path/to/Gsharp.NET.Sdk.VERSION.nupkg packages/
dotnet build
```

See [SDK projects](/docs/tooling/sdk-projects) for the full project-system walkthrough.

## Build the compiler from source

From a clone of the repository, restore and build the solution:

```bash
git clone https://github.com/DavidObando/gsharp.git
cd gsharp
dotnet build GSharp.sln
```

After the build, run the compiler DLL with `dotnet`. In direct `gsc` mode, passing `/out:path` emits an assembly; omitting `/out` runs the interpreter compatibility path.

```bash
dotnet src/Compiler/bin/Debug/net10.0/gsc.dll samples/HelloWorld.gs
dotnet src/Compiler/bin/Debug/net10.0/gsc.dll samples/HelloWorld.gs /out:artifacts/HelloWorld.dll /target:exe /tfm:net10.0
dotnet artifacts/HelloWorld.dll
```

Common `gsc` flags include `/out`, `/target:exe`, `/target:library`, `/tfm`, `/r`, `/noimplicitimports`, `/debug`, `/pdb`, `/nowarn`, and `/warnaserror`. See [the `gsc` reference](/docs/tooling/gsc) for details.
