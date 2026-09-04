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
| `[]T` | `[]T` | Slices are backed by CLR arrays and expose `.Length`; use `List[T]` for growable storage. `[]T?` means nullable elements, while `[]?T` means the slice itself may be `nil`. |
| `[3]T` | `[3]T` | Fixed arrays carry the length in the type; the expression `[n]T` allocates a zero-initialized runtime-length `[]T`. |
| `map[K,V]` | `map[K,V]` or `Dictionary[K, V]` | CLR generic syntax uses brackets. |
| `struct` | `struct`, `data struct`, `data class`, or `class` | G# also has CLR classes and structural data aggregates. |
| exported by `Name` | `public Name` | Visibility is explicit: `public`, `private`, or `internal`. |
| goroutine `go f()` | `go f()` | Scoped `go` joins through `scope`. |
| channel `chan T` | `chan[T]` | A `chan[T]` **is** `System.Threading.Channels.Channel<T>`; `<-chan T` / `chan<- T` are `in chan[T]` / `out chan[T]`. |
| `make(chan T)` / `make(chan T, n)` | `chan[T]()` / `chan[T](n)` | `chan[T]()` is a rendezvous channel, exactly Go's unbuffered channel. |
| `close(ch)`, `len(ch)`, `cap(ch)` | `ch.Close()`, `ch.Length()`, `ch.Capacity` | Members, not built-ins; closing twice throws like Go's panic. |
| `v, ok := <-ch` | `let (v, ok) = <-ch` | `ok` is `false` once the channel is closed and drained. |
| `for v := range ch` | `for v in ch` (or `while let v = <-ch`) | Both loop until the channel is closed; a `nil` element of a `chan[T?]` is delivered, not mistaken for close. |
| `select` | `select` | Cases cover sends, receives, `default`, a `Task`, and cancellation. The ready arm is chosen uniformly at random, as in Go. |
| `case <-time.After(d)` | `case <-after(d)` | `after` and `tick` come from `Gsharp.Concurrency`, which is imported implicitly. |
| `case <-ctx.Done()` | `case cancelled` | The arm observes the enclosing `scope`'s context; without one the select unwinds on cancellation instead. |
| set a channel variable to `nil` to disable an arm | `case <-ch when enabled` | The guard is evaluated once when the select is entered; a false guard keeps the arm out entirely. |
| no equivalent | `case let v = await task` | A `Task` or `Task[T]` races the channels on the same waiter. |
| `len(xs)`, `append(xs, v)`, `delete(m, k)` | `xs.Length`, `List[T]` + `.Add(v)`, `m.Remove(k)` | The Go-style built-ins are retired (GS0566 names the member). |
| `defer cleanup()` | `defer cleanup()` | Defers run at block exit. |
| `interface{}` | `object` or an interface type | CLR object identity and interfaces apply. |
| `error` returns | exceptions or result values | G# interoperates with .NET exceptions. |
| nil coalescing | `value ?? fallback` | The operator is `??`, not the old G# `?:` spelling. |
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
