---
title: "Quickstart: Hello, G#"
description: "Write, run, and understand your first complete G# program."
sidebar_position: 2
---

# Quickstart: Hello, G#

Run a small program, understand its parts, then make a change. If you have not installed G# yet, follow the [installation guide](install.md) first.

## The program

Replace your project's `Program.gs` with the checked-in `samples/HelloWorld.gs` example:

```gsharp title="Program.gs"
// file: HelloWorld.gs

package HelloWorld

import System

Console.WriteLine("Hello, world!")
```

There are three ideas here:

- `package HelloWorld` gives the source a package identity.
- `import System` brings a .NET namespace into scope.
- `Console.WriteLine` calls the familiar .NET console API. Top-level statements become the executable entry point, so you do not need to declare `Main`.

## Run it with the SDK

From the project directory:

```bash
dotnet run
```

Expected output:

```text
Hello, world!
```

Change the message and run it again. `dotnet run` builds the project when needed; a separate `dotnet build` is useful when you want to compile without executing.

**Next:** follow the [Tour's basics chapter](../tour/basics.md), or [build a small data model](../tutorials/getting-started.md).

## Run it with `gsc` directly

The SDK is the recommended project workflow. If you are working with a source-built compiler, you can also execute the sample directly:

```bash
dotnet path/to/gsc.dll samples/HelloWorld.gs
```

The compiler prints:

```text
Hello, world!
Success.
```

Use `/out` when you want an assembly rather than immediate execution:

```bash
dotnet path/to/gsc.dll samples/HelloWorld.gs /out:artifacts/HelloWorld.dll /target:exe /tfm:net10.0
dotnet artifacts/HelloWorld.dll
```

The saved program prints `Hello, world!` without the compiler's `Success.` line. See the [compiler reference](../tooling/gsc.md) for advanced invocation options.
