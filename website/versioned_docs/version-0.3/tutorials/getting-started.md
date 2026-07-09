---
title: "Tutorial: Getting started"
sidebar_position: 1
draft: false
---

# Tutorial: Getting started

In this tutorial, you will create a G# console project, replace the template body with a checked-in sample program, build it with the G# MSBuild SDK, and run it with `dotnet run`.

## Prerequisites

- The .NET SDK that can target `net10.0`.
- A terminal in a directory where you can create a project.
- The [`Gsharp.Templates`](https://www.nuget.org/packages/Gsharp.Templates/) package, available on NuGet. It installs the [`Gsharp.NET.Sdk`](https://www.nuget.org/packages/Gsharp.NET.Sdk/) used by the generated project, both resolved from the public NuGet feed.

## 1. Scaffold a console app

Install the template and create a project:

```bash
$ dotnet new install Gsharp.Templates
$ dotnet new gsharp-console -n MyApp
$ cd MyApp
```

The template follows the same three-command flow shown in the repository README:

```bash
$ dotnet build
$ dotnet run
Hello from GSharp!
```

That proves the SDK, template, compiler, and runtime are all wired together.

## 2. Inspect the project file

A scaffolded project is an ordinary .NET project whose SDK is `Gsharp.NET.Sdk`:

```xml title="MyApp.gsproj"
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
</Project>
```

The SDK automatically includes `.gs` files in the project directory. You only need explicit `Compile` items for source files outside the project directory.

## 3. Replace the program

Replace `Program.gs` with the checked-in `HelloWorld` sample:

```gsharp title="Program.gs"
// file: HelloWorld.gs

package HelloWorld

import System

Console.WriteLine("Hello, world!")
```

A G# source file starts with a `package` declaration. Imports then bring .NET namespaces into scope. The top-level call to `Console.WriteLine` becomes the console app entry point.

## 4. Build and run

Run the project again:

```bash
$ dotnet build
$ dotnet run
```

Expected output:

```text
Hello, world!
```

## 5. Try direct compiler output

The SDK is the normal project workflow, but the command-line compiler can also emit an executable when you pass `/out`:

```bash
$ dotnet path/to/gsc.dll Program.gs /out:bin/hello.dll /target:exe /tfm:net10.0
$ dotnet bin/hello.dll
```

When `/out` is omitted, `gsc` uses the interpreter path for compatibility. Prefer the SDK or `/out` when you want compiler-emitted behavior.

## Next steps

Continue with [Projects and packages](./project-and-packages) to learn how packages map to CLR namespaces and how `.gsproj` files organize larger programs.
