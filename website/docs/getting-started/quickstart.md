---
title: "Quickstart: Hello, G#"
sidebar_position: 2
draft: false
---

# Quickstart: Hello, G#

This page builds the smallest checked-in G# program two ways: with an SDK project and with `gsc` directly.

## The program

`samples/HelloWorld.gs` contains:

```gsharp title="HelloWorld.gs"
// file: HelloWorld.gs

package HelloWorld

import System

Console.WriteLine("Hello, world!")
```

Expected output:

```text
Hello, world!
```

The first non-comment line declares the package. Packages give code a namespace-like identity for compilation and imports. `import System` brings the CLR `System` namespace into scope, so the program can call `Console.WriteLine`. The last line is a top-level statement: G# can synthesize the executable entry point for simple programs without requiring an explicit `func Main`.

## Run it with the SDK

Create a console project, replace its `Program.gs` with the program above, then build and run:

```bash
dotnet new install Gsharp.Templates
dotnet new gsharp-console -n HelloWorld
cd HelloWorld
dotnet build
dotnet run
```

The SDK path is the everyday workflow. `Gsharp.NET.Sdk` wires `.gs` files into MSBuild, passes project references and target framework information to `gsc`, and emits a normal .NET executable.

## Run it with `gsc` directly

When you pass source files to `gsc` without `/out`, the compiler uses interpreter compatibility mode:

```bash
dotnet path/to/gsc.dll samples/HelloWorld.gs
```

Output:

```text
Hello, world!
Success.
```

The `Success.` line is printed by `gsc` after interpreter execution completes.

To emit an assembly, add `/out`. For an executable, keep `/target:exe`; `/tfm` selects the target framework runtime config.

```bash
dotnet path/to/gsc.dll samples/HelloWorld.gs /out:artifacts/HelloWorld.dll /target:exe /tfm:net10.0
dotnet artifacts/HelloWorld.dll
```

Output:

```text
Hello, world!
```

Use the emit path for application builds and for CLR interop scenarios that need real delegates, metadata, Portable PDBs, or runtime config files. The interpreter is convenient for quick checks, but it does not model every emitted CLR behavior.

Next: [A Tour of G#](/docs/tour).
