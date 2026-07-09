---
title: "Concurrency and async"
sidebar_position: 6
draft: false
---

# Concurrency and async

G#'s production concurrency surface is built on three pieces:

- **`scope { ... }`** — structured-concurrency blocks that wait for the
  work they own and surface its failures.
- **`async func` + `await`** — task-based asynchrony that interoperates
  with the .NET `Task` and `Task[T]` types.
- **`sequence[T]` + `async sequence[T]`** — synchronous and asynchronous
  iterators built on `yield` and consumed with `for` / `await for`.

This guide focuses on the always-available surface. The optional
Go-flavored layer (`go`, `chan T`, `select`, `close`, `make(chan ...)`)
lives in [Extensions: Go-flavored concurrency](../extensions/go-concurrency).

## `scope` — structured concurrency

`scope { ... }` runs its body and, before returning, joins every async
operation that was registered with it. The two things that register with
the enclosing scope are:

1. `await expr` inside the scope — the awaited task becomes part of the
   scope's join set.
2. `go call(...)` inside the scope when `import Gsharp.Extensions.Go` is
   present — the goroutine task is registered and joined.

Either way, exceptions from registered work surface as the scope
unwinds, instead of being silently dropped.

```gsharp
import System
import System.Threading.Tasks

async func work(label string) {
    await Task.Delay(1)
    Console.WriteLine("done: $label")
}

scope {
    work("a").Wait()
    work("b").Wait()
}

Console.WriteLine("after scope")
```

Use `scope` when a parent operation should not return before its
children. If you find yourself reaching for a `Task[]` array and
`Task.WhenAll`, a `scope` block is usually the simpler shape.

## `async func` and `await`

`async func` declares a function that produces a `Task` (for `void`) or
`Task[T]` (for a value return). `await expr` suspends the surrounding
async function until the awaited task completes and yields its result.

```gsharp title="AsyncTask.gs"
package GSharp.Samples.AsyncTask

import System
import System.Threading.Tasks

async func compute(n int32) int32 {
    await Task.Delay(5)
    return n * 2
}

async func runAll() int32 {
    let a = await compute(3)
    let b = await compute(4)
    Console.WriteLine("a = $a")
    Console.WriteLine("b = $b")
    return 0
}

runAll().Wait()
Console.WriteLine("done")
```

Top-level scripts that need to drive an async entry point can `await`
inside a scope, or call `.Wait()` (or `.GetAwaiter().GetResult()`) on
the returned task when blocking is acceptable.

Async function *type clauses* are written `async (T) -> R` and lower to
`(T) -> Task[R]` (or `(T) -> Task` for void). Writing the explicit task
type in the return slot of an `async (T) -> ...` clause is diagnosed —
the `async` marker already supplies the task shape.

```gsharp
// Field that holds an async callback.
var onReady (string) -> Task = (msg string) -> Task.CompletedTask
var publish async (string) -> void = (msg string) -> Console.WriteLine(msg)
```

`await` is a prefix expression and is only valid inside `async`
contexts; using it elsewhere or on a non-awaitable operand is
diagnosed.

## Sequences and async sequences

A function returning `sequence[T]` can use `yield` to produce values
lazily; the compiler emits a synchronous iterator that materializes
each value on demand.

```gsharp
func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}

for n in numbers() {
    Console.WriteLine(n)
}
```

`async sequence[T]` is the asynchronous counterpart and is consumed
with `await for`. The compiler lowers it to `IAsyncEnumerable[T]`, so
it interoperates directly with .NET async streams.

```gsharp
async sequence[int32] pulses() {
    for i in 1 ... 4 {
        await Task.Delay(5)
        yield i
    }
}

async func consume() {
    await for n in pulses() {
        Console.WriteLine(n)
    }
}
```

Combine `scope` with `await for` to bound the lifetime of an async
iterator. The scope joins the iterator's outstanding work before it
returns.

## Cleanup and concurrency

`defer` and `using` are scoped constructs and compose naturally with
`scope`:

```gsharp
scope {
    using let stream = File.OpenRead(path)
    let total = await ProcessAsync(stream)
    Console.WriteLine("total: $total")
}
```

Prefer `using` for any value that implements `IDisposable` (or
`IAsyncDisposable` in async contexts) and `defer` for small cleanup
calls that are not themselves represented by a disposable value.

## Concurrency model

The async lowering preserves loop back-edges across suspension points,
so awaits inside `for`, `while`, and nested loops behave the same as
they do in straight-line code. The runtime is the standard .NET
`Task`/`Task<T>` machinery, so synchronization primitives
(`SemaphoreSlim`, channels, locks) from `System.Threading.*` are all
available through normal imports.

## See also

- [Tutorial: Async and sequences](../tutorials/async-and-sequences)
- [Extensions: Go-flavored concurrency](../extensions/go-concurrency)
  — channels, `go`, `select`, and `close` for projects that import
  `Gsharp.Extensions.Go`.
