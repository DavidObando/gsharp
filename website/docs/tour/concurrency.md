---
title: "Tour: Concurrency"
sidebar_position: 5
draft: false
---

# Tour: Concurrency

G# uses `scope` for structured concurrency, `async func` and `await`
for task-based asynchrony, and `async sequence[T]` for asynchronous
streams. The same `Task` and `Task[T]` types you know from the .NET
BCL show up everywhere — async G# composes directly with C#, F#, and
the rest of the ecosystem.

## `scope` — structured concurrency

`scope { ... }` runs its body and, before returning, joins every async
operation registered with it. Awaiting inside a scope registers the
awaited task; failures propagate as the scope unwinds, so child work
is never silently lost.

```gsharp title="ScopeBasic.gs"
package GSharp.Tour.ScopeBasic

import System
import System.Threading.Tasks

async func tick(label string) {
    await Task.Delay(1)
    Console.WriteLine("done: $label")
}

scope {
    tick("a").Wait()
    tick("b").Wait()
}

Console.WriteLine("after scope")
```

```text
done: a
done: b
after scope
```

Use `scope` whenever a parent operation should not return before its
children. It is the structured replacement for "fire a task and hope
it finishes".

## `async func` and `await`

`async func` declares a function that returns a `Task` (or `Task[T]`).
`await expr` suspends the surrounding async function until the awaited
task completes and yields its result.

```gsharp title="AsyncBasics.gs"
package GSharp.Tour.AsyncBasics

import System
import System.Threading.Tasks

async func compute(n int32) int32 {
    await Task.Delay(5)
    return n * 2
}

async func runAll() {
    let a = await compute(3)
    let b = await compute(4)
    Console.WriteLine("a = $a, b = $b")
}

runAll().Wait()
Console.WriteLine("done")
```

```text
a = 6, b = 8
done
```

The async lowering preserves loop back-edges across suspension points,
so awaits inside `for`, `while`, and nested loops behave the same as
they do in straight-line code.

## `async sequence[T]` — asynchronous streams

A function returning `sequence[T]` produces a synchronous iterator;
`async sequence[T]` produces an asynchronous one. Async sequences are
consumed with `await for`:

```gsharp title="AsyncSequence.gs"
package GSharp.Tour.AsyncSequence

import System
import System.Threading.Tasks

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

consume().Wait()
```

```text
1
2
3
done
```

`async sequence[T]` lowers to .NET's `IAsyncEnumerable[T]`, so it
interoperates directly with `await foreach` on the C# side.

## Channels and goroutines

G# also offers a Go-flavored layer — `go`, `chan T`, `select`, `close`,
`make(chan T, ...)` — in the `Gsharp.Extensions.Go` package for projects
that prefer that style. See
[Extensions: Go-flavored concurrency](../extensions/go-concurrency) for
the full surface and the matching opt-in semantics.

Next: [Tour: .NET interop](/docs/tour/dotnet-interop).
