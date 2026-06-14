---
title: "G# for Go developers"
sidebar_position: 1
draft: false
---

# G# for Go developers

G# brings Go-style ergonomics — packages, `func`, `defer`, `for`, slices — to the .NET runtime alongside Kotlin- and Swift-style modern affordances. You will recognize packages, `func`, `defer`, `go`, channels, `select`, `for`, and slices, while the type system and runtime are intentionally CLR-shaped.

## Quick comparison

| Go construct | G# equivalent | Notes |
| --- | --- | --- |
| `package main` | `package MyApp.Cli` | Packages map to CLR namespaces rather than import paths. |
| `import "fmt"` | `import System` | Imports bind CLR namespaces, G# packages, and aliases. |
| `func main()` | top-level statements or `func Main()` | SDK projects synthesize an entry point from top-level statements. |
| `fmt.Println(x)` | `Console.WriteLine(x)` | Use .NET library types directly. |
| `var x int` | `var x int` (alias for `int32`) or `var x int32` | G# accepts both the friendly `int` alias and the canonical `int32`. The alias resolves to the canonical type at the binder, so diagnostics and IL print the width-bearing name.  |
| `:=` | `let x = …` or `var x = …` | G# removed the Go-style `:=` short declaration; every binding site requires `let` (immutable) or `var` (mutable). For ranges, write `for i in lo ... hi` and `for v in xs`. |
| `[]T` | `[]T` | Slices are backed by CLR arrays and expose `.Length`; use `List[T]` for growable storage. |
| `[3]T` | `[3]T` | Fixed arrays carry the length in the type. |
| `map[K,V]` | `map[K,V]` or `Dictionary[K, V]` | CLR generic syntax uses brackets. |
| `struct` | `struct`, `data struct`, `data class`, or `class` | G# also has CLR classes and structural data aggregates. |
| exported by `Name` | `public Name` | Visibility is explicit: `public`, `private`, or `internal`. |
| goroutine `go f()` | `go f()` | Scoped `go` joins through `scope`. |
| channel `chan T` | `chan T` | Lowered to `System.Threading.Channels`. |
| `select` | `select` | Cases cover sends, receives, and `default`. |
| `defer cleanup()` | `defer cleanup()` | Defers run at block exit. |
| `interface{}` | `object` or an interface type | CLR object identity and interfaces apply. |
| `error` returns | exceptions or result values | G# interoperates with .NET exceptions. |
| generics `func F[T any]` | `func F[T](x T) T` | Type parameters use bracket syntax without Go constraints. |
| automatic semicolons | none | Newlines are significant in the grammar; do not rely on semicolon insertion. |

## Packages are CLR namespaces

In Go, the package clause and module path determine import identity. In G#, a file starts with `package`, and that package becomes the emitted CLR namespace:

```gsharp
package Inventory.Cli

import System

Console.WriteLine("inventory")
```

A single `.gsproj` can contain several packages and emit one assembly. That makes `internal` visibility assembly-scoped, just like C#.

## Numbers name their width

Go's `int` has architecture-dependent width. G# makes width explicit in source: `int8`, `int16`, `int32`, `int64`, `uint32`, `float32`, `float64`, and friends. That keeps CLR signatures stable and avoids surprises when calling .NET APIs.

## Visibility is not capitalization

Go exports identifiers by capitalization. G# uses explicit modifiers:

```gsharp
public class Customer {
    private id string
    internal func DebugId() string { return id }
}
```

This matches CLR metadata and lets `PascalCase` or `camelCase` be stylistic choices rather than access control.

## Control flow is familiar, but switches do not fall through

G# keeps compact `if`, `for`, `for in`, `switch`, and `select` forms. Switch cases do not fall through. The `fallthrough` keyword is reserved only so the compiler can issue a clear diagnostic.

## Generics and CLR interop use bracket syntax

Generic type and method arguments use brackets:

```gsharp
import System.Collections.Generic

let names = List[string]()
names.Add("gopher")
```

G# can construct CLR types, call methods and properties, subscribe to events, convert functions to delegates on the emit path, and use extension methods.

## Exceptions are part of the platform

Go code normally returns `error`. G# can still model results explicitly, but imported .NET APIs throw exceptions. Use `try`, `catch`, `finally`, or `using` when you are working with APIs that follow .NET conventions.

## Where to go next

- [Getting started](/docs/tutorials/getting-started)
- [Data and types](/docs/tutorials/data-and-types)
- [Concurrency](/docs/tutorials/concurrency)
- [CLR interop reference](/docs/ref/clr-interop)
