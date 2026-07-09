---
title: "G# for C# developers"
sidebar_position: 2
draft: false
---

# G# for C# developers

G# is a modern .NET language with concise syntax influenced by Go, Kotlin, and Swift. It emits CLR assemblies, imports CLR namespaces, and interoperates with C#, but it chooses packages, functions, structural data types, channels, and explicit width-bearing primitives.

## Quick comparison

| C# construct | G# equivalent | Notes |
| --- | --- | --- |
| `namespace MyApp;` | `package MyApp` | A package becomes the emitted CLR namespace. |
| `using System;` | `import System` | Imports bring CLR namespaces and G# packages into scope. |
| `static void Main()` | top-level statements or `func Main()` | SDK projects synthesize an entry point; an explicit entry point is named `Main`. |
| `void M()` | `func M()` | Functions can be package-level or members. |
| method declaration in a class | class-body `func M()` (canonical) or `func (r Receiver) M()` for unowned types | Receiver clauses on owned types emit the `GS0314` warning — declare the method inside the class body instead. |
| `int` | `int32` (canonical) or `int` (alias) | The friendly `int` / `long` / `byte` / `float` aliases resolve to the canonical width-bearing names at the binder; canonical spellings are preferred in public APIs. |
| `long` | `int64` (canonical) or `long` (alias) | CLR signatures stay obvious in source. |
| `var x = ...;` | `let x = ...` or `var x = ...` | `let` is immutable; `var` is mutable. |
| object initializer `new T { F = v }` | brace initializer `T{F: v}` | Data structs also offer `.copy(F: v)` and `with` copy/update. |
| anonymous type `new { A = x }` | `object { let A = x }` | Field-only anonymous objects infer member types; rich anonymous objects can implement interfaces or extend a base class. |
| collection initializer `new List<int>{1,2}` | `List[int32]{1, 2}` | Dictionaries support `"k": v` and `[k] = v` entries. |
| structural value/reference aggregate | `data struct` / `data class` | Structural value or reference aggregates. |
| `readonly struct CustomerId` | `inline struct CustomerId(value string)` | Inline structs are nominal single-field wrappers. |
| partial type | `partial class` / `partial struct` / `partial interface` | Partial enums and partial members are not supported. |
| `Task<T>` | `Task[T]` | Generic type arguments use brackets. |
| `async Task<T>` | `async func ... T` | Await is available inside async functions. |
| `IEnumerable<T>` iterator | `sequence[T]` with `yield` | Async streams use `async sequence[T]`. |
| `lock` and tasks | `go`, `chan T`, `select`, `scope` | G# adds structured concurrency over .NET tasks and channels. |
| `using var` or `using (...)` | `using` and `defer` | Defer and using cleanup at block exit. |
| `void M(int x = 0)` | `func M(x int32 = 0)` | G# functions support optional parameters with constant defaults. |
| `void M(int x, int y); void M(int x);` | overloads of `M(int32, int32)` / `M(int32)` | G# functions support overloading on parameter shape; duplicates report `GS0264`. |
| `ref int M(int[] a, int i)` | `func M(a []int32, i int32) ref int32` paired with `return ref a[i]` | Ref returns. |
| `ref int local = ref arr[i]` | `let ref local = arr[i]` or `var ref local = arr[i]` | Ref-aliasing locals. |
| `out int n` parameter / `M(out var n)` | `out n int32` / `M(out var n)` | Ref-kind parameters and inline `out` declarations. |
| `delegate void Handler(object sender)` | `type Handler = delegate func(sender Object)` | Named delegate types. |
| `cond ? a : b` | `cond ? a : b` | Ternary expression. |
| `a ?? b`, `a ??= b` | `a ?? b`, `a ??= b` | The old G# `?:` null-coalescing spelling is removed. |
| `using static System.Math;` | `import System.Math` | Static members are available as an unqualified fallback. |
| `unsafe`, pointers, `stackalloc`, `fixed` | `unsafe`, `*T`, `stackalloc [n]T`, `fixed p *T = source { ... }` | `*void` maps C# `void*`; raw-pointer operations require an unsafe context. |
| `/// <summary>…</summary>` XML doc | `/// summary text` Markdown doc | Markdown documentation comments round-trip to CLR XML. |
| lambda `x => x + 1` | `x -> x + 1` | Arrow lambdas with inferred parameter/return types are the canonical lambda form. |
| extension method | `func (r Receiver) M()` on a non-owned `Receiver` | A receiver clause declares a CLR-visible extension method. The receiver type must be a type the package does not own. |

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

C# source uses aliases such as `int` and `long`. G# canonical spellings are the width-bearing `int32`, `int64`, `uint32`, `float64`, and so on — that makes interop signatures visually match CLR metadata. G# also accepts the C#-style aliases `int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, and `double` as a strict superset; they resolve at the binder to the canonical type, so diagnostics and IL always print the width-bearing name. Prefer the canonical spellings in public library APIs and reach for the friendly aliases inside function bodies and local code where brevity helps reading.

## Defaults, named arguments, and overloading

G# user functions support optional parameters with compile-time-constant defaults, named arguments at the call site, and overload sets:

```gsharp
func greet(name string = "world", excited bool = false) string {
    return excited ? "hi, $name!" : "hi, $name"
}

// Default values: both optional.
let a = greet()                    // "hi, world"
let b = greet("Ada")                 // "hi, Ada"

// Named arguments: arrive in any order, skip leading defaults.
let c = greet(excited: true)         // "hi, world!"
let d = greet(name: "Ada", excited: true)

// Overloading by parameter shape.
func area(width int32, height int32) int32 { return width * height }
func area(side int32) int32                { return side * side }
```

Imported CLR methods that expose `[Optional]` arguments work the same way G# defaults do, and CLR overload sets resolve identically. Use the `name: value` spelling for named arguments, including `.copy(...)` calls and attribute argument lists; `GS0315` identifies the older separator form.

## Data shapes are richer than plain classes

Use `class` for reference identity and inheritance. Use `struct` for value aggregates. Use `data class` or `data struct` for structural equality, copy/update, and deconstruction. Use `inline struct` when you want a nominal wrapper over one value. Use `sealed class` for a Kotlin-style closed hierarchy, and a payload-bearing `enum` for a discriminated union.

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

## Concurrency is structured and .NET-backed

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

## Lambdas use arrow syntax

Lambdas use arrow syntax with delegate conversions on the emit path. Parameter and return types are inferred from the target delegate (the canonical form); they can also be written explicitly:

```gsharp
let evens = nums.Where(x -> x % 2 == 0)   // canonical: inferred, bare single param
let twice = func (x int32) int32 { return x * 2 }   // explicit alternative
```

Passing G# lambdas to imported CLR methods is supported when you build through the SDK or `gsc /out`. The interpreter path does not support that conversion.

## Low-level interop syntax is G#-shaped

Unsafe code keeps the C# concepts but uses G# grammar:

```gsharp
unsafe func fill(dest []uint8) {
    fixed p *uint8 = dest {
        p[0] = 42
    }
}

unsafe func scratch() {
    var span = stackalloc [4]uint8{1, 2, 3, 4}
}
```

Use `unmanaged` constraints and `sizeof(T)` for generic pointer code. Pointer member access supports `p->Field` as sugar for `(*p).Field`.

## Anonymous and partial types

C# anonymous types translate to `object { ... }` literals. Field-only literals infer member types; `data object` adds value semantics and `with` copy/update. Rich anonymous objects can implement an interface or extend a base class, but rich object fields need explicit types.

Use `partial` on every split declaration of a class, struct, or interface. The compiler merges parts into one emitted CLR type; partial methods/properties and partial enums are not part of the 0.3 surface.

## Where to go next

- [Getting started](/docs/tutorials/getting-started)
- [Projects and packages](/docs/tutorials/project-and-packages)
- [.NET interop](/docs/tutorials/dotnet-interop)
- [SDK projects](/docs/tooling/sdk-projects)
