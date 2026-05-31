---
title: "G# for C# developers"
sidebar_position: 2
draft: false
---

# G# for C# developers

G# is a .NET language with Go-inspired syntax. It emits CLR assemblies, imports CLR namespaces, and interoperates with C#, but it chooses packages, functions, structural data types, channels, and explicit width-bearing primitives.

## Quick comparison

| C# construct | G# equivalent | Notes |
| --- | --- | --- |
| `namespace MyApp;` | `package MyApp` | A package becomes the emitted CLR namespace. |
| `using System;` | `import System` | Imports bring CLR namespaces and G# packages into scope. |
| `static void Main()` | top-level statements or `func main()` | SDK projects synthesize an entry point. |
| `void M()` | `func M()` | Functions can be package-level or members. |
| method declaration in a class | `func (r Receiver) M()` or class member syntax | G# supports receiver-style and class-shaped members. |
| `int` | `int32` | G# source names numeric widths explicitly. |
| `long` | `int64` | CLR signatures stay obvious in source. |
| `var x = ...;` | `let x := ...` or `var x := ...` | `let` is immutable; `var` is mutable. |
| object initializer | constructor plus assignments or data copy | Data structs use structural copy/update ergonomics. |
| `record struct` | `data struct` or `record` | `record` is an alias for `data struct`. |
| `readonly struct CustomerId` | `inline struct CustomerId(string)` | Inline structs are nominal single-field wrappers. |
| `Task<T>` | `Task[T]` | Generic type arguments use brackets. |
| `async Task<T>` | `async func ... T` | Await is available inside async functions. |
| `IEnumerable<T>` iterator | `sequence[T]` with `yield` | Async streams use `async sequence[T]`. |
| `lock` and tasks | `go`, `chan T`, `select`, `scope` | G# adds Go-shaped structured concurrency. |
| `using var` or `using (...)` | `using` and `defer` | Defer and using cleanup at block exit. |
| optional parameter defaults | imported CLR optional args only | G# user functions do not define default parameter values. |
| lambda `x => x + 1` | `x -> x + 1` | Trailing-arrow lambdas are the canonical expression form. |
| extension method | `extension func` | G# emits CLR-visible extension methods. |

## Packages replace namespaces in source

Every G# file starts with a package declaration:

```gsharp
package Acme.Tools

import System

Console.WriteLine("tools")
```

The emitted namespace is `Acme.Tools`. A `.gsproj` can contain many packages, and all files compile into the same assembly unless you split them into separate projects.

## Functions are central

Package-level `func` declarations are ordinary static-like entry points. Classes and structs can still have members, constructors, properties, events, inheritance, and operator interop, but G# does not require everything to live on a class.

```gsharp
func add(a int32, b int32) int32 {
    return a + b
}
```

## Primitive names make CLR widths explicit

C# source uses aliases such as `int` and `long`. G# spells the widths: `int32`, `int64`, `uint32`, `float64`, and so on. This makes interop signatures visually match CLR metadata.

## Defaults and optional arguments differ

G# user-defined functions do not declare default parameter values. Imported CLR methods and extension methods can still expose optional arguments from metadata, and G# callers may omit those arguments.

## Data shapes are richer than plain classes

Use `class` for reference identity and inheritance. Use `struct` for value aggregates. Use `data struct` or `record` for structural equality, copy/update, and deconstruction. Use `inline struct` when you want a nominal wrapper over one value.

```gsharp
data struct Point { X int32; Y int32 }
let p := Point(1, 2)
let q := p with { X: 3 }
```

## Concurrency is Go-shaped and .NET-backed

G# adds `go`, `chan T`, `select`, and `scope`. The lowering targets .NET tasks and channels, so code can coordinate with CLR async APIs while retaining concise channel syntax.

```gsharp
let ch := make(chan string, 1)
ch <- "ready"
select {
case msg := <-ch:
    Console.WriteLine(msg)
default:
    Console.WriteLine("idle")
}
```

## Lambdas use trailing arrows

Expression lambdas use `->`, including delegate conversions on the emit path:

```gsharp
let twice := (x int32) -> x * 2
```

Passing G# func literals to imported CLR methods is supported when you build through the SDK or `gsc /out`. The interpreter path does not support that conversion.

## Where to go next

- [Getting started](/docs/tutorials/getting-started)
- [Projects and packages](/docs/tutorials/project-and-packages)
- [.NET interop](/docs/tutorials/dotnet-interop)
- [SDK projects](/docs/tooling/sdk-projects)
