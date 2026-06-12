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
| `static void Main()` | top-level statements or `func Main()` | SDK projects synthesize an entry point; an explicit entry point is named `Main`. |
| `void M()` | `func M()` | Functions can be package-level or members. |
| method declaration in a class | class-body `func M()` (canonical) or `func (r Receiver) M()` for unowned types | Per [ADR-0079](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0079-restrict-receiver-clauses-to-non-owned-types.md), receiver clauses on owned types emit the `GS0314` warning — declare the method inside the class body instead. |
| `int` | `int32` | G# source names numeric widths explicitly. |
| `long` | `int64` | CLR signatures stay obvious in source. |
| `var x = ...;` | `let x = ...` or `var x = ...` | `let` is immutable; `var` is mutable. (The short `x := ...` form was removed by [ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md).) |
| object initializer `new T { F = v }` | brace initializer `T{F: v}` | Data structs also offer `.copy(F: v)` and `with` copy/update. |
| `record struct` | `data struct` | The `record` keyword was removed by ADR-0078; `data struct Name(...)` is the canonical spelling. |
| `record class` | `data class` | Reference-typed record. |
| `readonly struct CustomerId` | `inline struct CustomerId(value string)` | Inline structs are nominal single-field wrappers. |
| `Task<T>` | `Task[T]` | Generic type arguments use brackets. |
| `async Task<T>` | `async func ... T` | Await is available inside async functions. |
| `IEnumerable<T>` iterator | `sequence[T]` with `yield` | Async streams use `async sequence[T]`. |
| `lock` and tasks | `go`, `chan T`, `select`, `scope` | G# adds Go-shaped structured concurrency. |
| `using var` or `using (...)` | `using` and `defer` | Defer and using cleanup at block exit. |
| `void M(int x = 0)` | `func M(x int32 = 0)` | G# functions support optional parameters with constant defaults (ADR-0063). |
| `void M(int x, int y); void M(int x);` | overloads of `M(int32, int32)` / `M(int32)` | G# functions support overloading on parameter shape (ADR-0063); duplicates report `GS0264`. |
| named arg `M(timeout: 30)` | `M(timeout: 30)` (legacy `M(timeout = 30)` deprecated, GS0315) | Named arguments at call sites for user functions, methods, constructors, extensions, and CLR methods. The `=` separator emits the `GS0315` warning ([ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md)) and is removed in a later release. |
| `ref int M(int[] a, int i)` | `func M(a []int32, i int32) ref int32` paired with `return ref a[i]` | Ref returns (ADR-0060 follow-up). |
| `ref int local = ref arr[i]` | `let ref local = arr[i]` or `var ref local = arr[i]` | Ref-aliasing locals. |
| `out int n` parameter / `M(out var n)` | `out n int32` / `M(out var n)` | Ref-kind parameters and inline `out` declarations (ADR-0060). |
| `delegate void Handler(object sender)` | `type Handler = delegate func(sender Object)` | Named delegate types (ADR-0059). |
| `cond ? a : b` | `cond ? a : b` | Ternary expression (ADR-0062). |
| `/// <summary>…</summary>` XML doc | `/// summary text` Markdown doc | Markdown documentation comments round-trip to CLR XML (ADR-0057). |
| lambda `x => x + 1` | `(x int32) -> x + 1` (or `func(x int32) int32 { return x + 1 }`) | Arrow lambdas (ADR-0074) and func literals are both valid; the arrow form is the canonical one-liner. |
| extension method | `func (r Receiver) M()` on a non-owned `Receiver` | A receiver clause declares a CLR-visible extension method. The receiver type must be a type the package does not own ([ADR-0079](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0079-restrict-receiver-clauses-to-non-owned-types.md)). |

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

## Defaults, named arguments, and overloading

G# user functions support optional parameters with compile-time-constant defaults, named arguments at the call site, and overload sets — all introduced in ADR-0063 and complementary issues:

```gsharp
func greet(name string = "world", excited bool = false) string {
    return excited ? "hi, $name!" : "hi, $name"
}

// Default values: both optional.
let a = greet()                      // "hi, world"
let b = greet("Ada")                 // "hi, Ada"

// Named arguments: arrive in any order, skip leading defaults.
let c = greet(excited: true)         // "hi, world!"
let d = greet(name: "Ada", excited: true)

// Overloading by parameter shape.
func area(width int32, height int32) int32 { return width * height }
func area(side int32) int32                { return side * side }
```

Imported CLR methods that expose `[Optional]` arguments work the same way G# defaults do, and CLR overload sets resolve identically. The legacy `name = value` named-argument form is deprecated in this release ([ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md), `GS0315`) and removed in a later release; rewrite to `name: value` everywhere — including `.copy(...)` calls and attribute argument lists.

## Data shapes are richer than plain classes

Use `class` for reference identity and inheritance. Use `struct` for value aggregates. Use `data class` or `data struct` for structural equality, copy/update, and deconstruction. Use `inline struct` when you want a nominal wrapper over one value. Use `sealed class` for a Kotlin-style closed hierarchy, and a payload-bearing `enum` for a discriminated union (ADR-0078).

```gsharp
data struct Point {
    X int32
    Y int32
}

let p = Point{X: 1, Y: 2}
let q = p with { X = 3 }
let moved = p.copy(X: 3)
let (px, py) = p
```

## Concurrency is Go-shaped and .NET-backed

G# adds `go`, `chan T`, `select`, and `scope`. The lowering targets .NET tasks and channels, so code can coordinate with CLR async APIs while retaining concise channel syntax.

```gsharp
let ch = make(chan string, 1)
ch <- "ready"
select {
case let msg = <-ch {
    Console.WriteLine(msg)
}
default {
    Console.WriteLine("idle")
}
}
```

## Lambdas are func literals

Lambdas are written as `func` literals with explicit parameter and return types, including delegate conversions on the emit path:

```gsharp
let twice = func(x int32) int32 { return x * 2 }
```

Passing G# func literals to imported CLR methods is supported when you build through the SDK or `gsc /out`. The interpreter path does not support that conversion.

## Where to go next

- [Getting started](/docs/tutorials/getting-started)
- [Projects and packages](/docs/tutorials/project-and-packages)
- [.NET interop](/docs/tutorials/dotnet-interop)
- [SDK projects](/docs/tooling/sdk-projects)
