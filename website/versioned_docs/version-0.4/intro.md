---
title: "Introduction to G#"
description: "Meet G#: expressive syntax, explicit nullable types, and structured concurrency on the .NET runtime."
sidebar_position: 1
---

# Introduction to G#

G# is a programming language for .NET with expressive data types, explicit nullability, and structured concurrency. It brings familiar ideas from Go, Kotlin, and Swift to the libraries and tools of the .NET ecosystem.

Start with a small program. Add a project when you need one. Your source compiles into ordinary managed assemblies that can work alongside C# and F#.

## Who G# is for

If you already use .NET, G# offers a different way to express programs without starting over with a separate runtime and library ecosystem. If you know Go, packages, functions, and channels will look familiar, but G# uses .NET exceptions, nullable types, and CLR libraries.

Coming from Kotlin? Data classes and nullable flow provide familiar starting points, while library APIs, project tooling, and concurrency contracts change with the runtime. Start with [G# for Kotlin developers](bridges/gsharp-for-kotlin-developers.md).

Coming from Swift? Use the [Swift bridge](bridges/gsharp-for-swift-developers.md) to compare optionals, value types, resource lifetime, and .NET concurrency.

G# is pre-1.0 and still evolving. Read the [feature matrix](ref/feature-matrix.md) and [release notes](release-notes.md) before relying on a capability or upgrading a project. Published releases and Next documentation are distinct; the version selector tells you which documentation you are reading.

## Where to start

| Your goal | Start here |
| --- | --- |
| Run your first project | [Install G#](getting-started/install.md), then [Hello, G#](getting-started/quickstart.md) |
| Get a feel for the language | [A Tour of G#](tour/index.md) |
| Transfer your existing experience | [C#](bridges/gsharp-for-csharp-developers.md), [Go](bridges/gsharp-for-go-developers.md), [Kotlin](bridges/gsharp-for-kotlin-developers.md), or [Swift](bridges/gsharp-for-swift-developers.md) |
| Build something step by step | [Trail: a real .NET project](tutorials/trail.md) |
| Look up a concept or precise rule | [Concept quick reference](ref/quick-reference.md), then the [specification](ref/spec.md) |

## How G# runs

Use `dotnet build`, `dotnet run`, and an SDK-style `.gsproj` for normal project work. `Gsharp.NET.Sdk` connects the G# compiler to MSBuild.

For a single file, the `gsc` compiler can emit and run a program directly. The `gsi` REPL provides interactive exploration and script execution. All of these paths use the compiler emitter.

The published compiler requires .NET 10. Application target frameworks are a separate choice; see [SDK and project files](tooling/sdk-projects.md) for supported cross-targeting and reference assemblies. Compiler internals and historical execution engines belong in the [architecture reference](tooling/compiler-architecture.md), not in your first program.
