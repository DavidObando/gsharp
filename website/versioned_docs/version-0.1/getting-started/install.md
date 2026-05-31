---
title: "Install G#"
sidebar_position: 1
draft: false
---

# Install G#

G# projects build with the normal .NET tools. The recommended path is to use the MSBuild SDK and project template, both published on NuGet; compiler developers can also build `gsc` from source.

The published packages are [`Gsharp.NET.Sdk`](https://www.nuget.org/packages/Gsharp.NET.Sdk/) (the MSBuild SDK) and [`Gsharp.Templates`](https://www.nuget.org/packages/Gsharp.Templates/) (the `dotnet new` templates). They resolve from the public NuGet feed, so no extra feed configuration is required.

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

The generated project includes a `.gsproj`, a starter `Program.gs`, a `NuGet.config` that enables optional local SDK side-loading, and a README.

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

If you are developing the SDK itself and want to side-load a locally packed build, copy the package into the project's configured package source before building:

```bash
mkdir -p packages
cp /path/to/Gsharp.NET.Sdk.VERSION.nupkg packages/
dotnet build
```

See [SDK projects](/docs/tooling/sdk-projects) for the full project-system walkthrough.

## Install the VS Code extension

The G# VS Code extension is published on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gsharplang.vscode-gsharp). It adds syntax highlighting, language-server features, build/run commands, and debugger configuration for `.gs` and `.gsproj` files. Install it from within VS Code (search for "G#" in the Extensions view) or from the command line:

```bash
code --install-extension gsharplang.vscode-gsharp
```

See [the VS Code extension reference](/docs/tooling/vscode) for the full feature list and settings.

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
