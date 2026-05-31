---
title: "Tutorial: Projects and packages"
sidebar_position: 2
draft: false
---

# Tutorial: Projects and packages

In this tutorial, you will grow from one file to a project-shaped program. You will see how `package` declarations become CLR namespaces, how imports resolve .NET namespaces, and how the SDK turns `.gs` files into one assembly.

## Prerequisites

- A working project from [Getting started](./getting-started).
- Familiarity with `dotnet build` and `dotnet run`.

## 1. Start from the SDK project

Keep the project file small and let the SDK include `.gs` files automatically:

```xml title="MyApp.gsproj"
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
</Project>
```

`OutputType` chooses an executable, `TargetFramework` chooses the .NET target, and `RootNamespace` is the fallback assembly identity used by SDK builds. The SDK is validated by repository smoke tests for `net8.0` and `net10.0`.

## 2. Put helpers in another package

G# chooses a C#-faithful model for projects: one `.gsproj` is one assembly, and each file's `package` becomes a CLR namespace. That means a project can contain multiple packages.

```gsharp title="Math/Stats.gs"
package MyApp.Math

func Double(x int32) int32 {
    return x * 2
}
```

```gsharp title="Program.gs"
package MyApp.Cli

import System
import MyApp.Math

Console.WriteLine(Double(21))
```

Run it:

```bash
$ dotnet run
42
```

The package with top-level statements owns the synthesized entry point. Library-only packages can share the same assembly and still use `internal` visibility at assembly scope.

## 3. Import .NET packages and aliases

Imports can name G# packages or CLR namespaces. They can also use an alias:

```gsharp title="ImportAlias.gs"
// file: ImportAlias.gs

package ImportAlias

import sys = System

sys.Console.WriteLine("Hello from alias!")
```

Expected output:

```text
Hello from alias!
```

## 4. Use packages with real .NET types

The `CountWords` sample imports `System.Collections.Generic`, creates a CLR `Dictionary`, updates it through an indexer, and iterates it:

```gsharp title="CountWords.gs"
// file: CountWords.gs
//
// Phase 4 exit sample. Exercises the CLR-interop features that landed
// across PRs #62–#65 in one cohesive program:
//
//   - `Dictionary[K, V]` instantiation via the generic BCL type-position
//     resolver (Phase 4.4 / ADR-0020) and the CLR constructor-call
//     binder (Phase 4 exit, part 1).
//   - Indexer read/write on a CLR map (`counts[w]`) and instance method
//     calls (`counts.ContainsKey(w)`) via the CLR member-access binder
//     (Phase 4 exit, part 2).
//   - Range iteration over both an array (`for w := range words`) and a
//     CLR `IDictionary[K, V]` (`for k, v := range counts`) via the
//     for-range lowerer (Phase 4 exit, part 3).
//   - Cross-feature use of string interpolation (Phase 1.1) and the
//     fixed-size array literal syntax (Phase 3.A.2).
//
// Runs on both backends. Originally landed under `samples/aspirational/`
// (PR #66) because the emit pipeline could not yet encode CLR
// constructors / member access / for-range. The emit-parity work in PRs
// #67+ closes that gap, so this sample is now part of the top-level
// emit conformance harness (SampleConformanceTests) in addition to its
// interpreter-side sibling CountWordsSampleTests.

package GSharp.Example.CountWords

import System
import System.Collections.Generic

var words = [12]string{
    "the", "quick", "brown", "fox", "jumps", "over",
    "the", "lazy", "dog", "the", "quick", "fox",
}

var counts = Dictionary[string, int32]()

for w := range words {
    if counts.ContainsKey(w) {
        counts[w] = counts[w] + 1
    } else {
        counts[w] = 1
    }
}

for k, v := range counts {
    Console.WriteLine("$k: $v")
}
```

Expected output:

```text
the: 3
quick: 2
brown: 1
fox: 2
jumps: 1
over: 1
lazy: 1
dog: 1
```

## 5. Know when to add explicit `Compile` items

By default, all `.gs` files under the project directory are compiled. Add an explicit item only when the source is outside the project directory:

```xml
<ItemGroup>
  <Compile Include="..\Shared\Utilities.gs" />
</ItemGroup>
```

Do not add explicit `Compile` items for files already included by the SDK defaults, because the .NET SDK reports duplicate compile items.

## What you learned

- `package` names become CLR namespaces.
- A `.gsproj` can contain more than one package and still emit one assembly.
- `import` works for G# packages, CLR namespaces, and aliases.
- The SDK is the recommended build entry point; `gsc` is the compiler underneath it.
