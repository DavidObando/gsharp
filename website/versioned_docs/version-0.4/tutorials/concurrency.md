---
title: "Tutorial: Concurrency"
sidebar_position: 5
draft: false
description: "Coordinate concurrent work with scopes, channels, and G# runtime primitives."
---

# Tutorial: Concurrency

In this tutorial, you will use G#'s always-available concurrency
surface: `scope` for structured concurrency, `async func` and `await`
for task-based asynchrony, and `async sequence[T]` for asynchronous
streams.

`go`, channels, and `select` are also part of the language, without an opt-in import. This tutorial starts with scoped child work, then introduces .NET async APIs. See [Go-flavored concurrency](../extensions/go-concurrency.md) for channel ownership and [Trail](trail.md) for a complete worker-pool application.

## Prerequisites

- A working G# project.
- Basic familiarity with functions and loops.

## 1. Run async work inside `scope`

Start child work with `go` inside a `scope`. The scope joins those children before execution continues. Simply creating an unrelated .NET task inside a block is not a substitute for registering owned child work.

This complete example is `samples/WebsiteConcurrency.gs`:

```gsharp title="workers.gs"
package Website.Concurrency

import System

func send(value int32, results chan[int32]) {
    results <- value
}

let results = chan[int32](2)

scope {
    go send(10, results)
    go send(32, results)
}

Console.WriteLine(<-results + <-results)
```

Expected output:

```text
42
```

The children can run concurrently; their completion order is unspecified. The sum is deterministic, and both sends have finished when the scope exits. The buffer has room for both values, so the parent can receive them after the join. A bounded pipeline that consumes while workers run is shown in [Trail](trail.md).

If a child fails, the scope observes the failure; see [scope failure behavior](../guide/concurrency.md#scope--structured-concurrency) for cancellation and exception details.

## 2. Write an `async func`

`async func` with an omitted return type returns `Task`; declaring a value
type returns `Task[T]`. Explicit `async func handler() void` is the C#
`async void` event-handler shape and is not awaitable. Inside the body you
can `await` any awaitable — most commonly a `Task` from the .NET BCL:

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

Expected output:

```text
a = 6
b = 8
done
```

`runAll` returns `Task[int32]` — the compiler constructs `Task[T]` for
any value-typed result (`int32`, `bool`, `float64`, …) automatically.

## 3. Await inside loops

The async lowering preserves loop back-edges across suspension points,
so a single `await` inside a loop iterates the loop the expected number
of times:

```gsharp title="AsyncAwaitInLoop.gs"
package GSharp.Samples.AsyncAwaitInLoop

import System
import System.Threading.Tasks

async func loopy() {
    var n = 0
    for n < 3 {
        await Task.Delay(1)
        n = n + 1
        Console.WriteLine("tick $n")
    }
}

loopy().Wait()
Console.WriteLine("done")
```

Expected output:

```text
tick 1
tick 2
tick 3
done
```

The same is true of multiple awaits in one iteration, and of nested
loops with awaits at different levels. You can rely on it as a basic
language guarantee.

## 4. Combine `scope` with an async operation

A `scope` can wrap any async-call site and become its join point. When
the scope returns, the work has either completed or thrown.

```gsharp title="ScopeAsync.gs"
package GSharp.Tour.ScopeAsync

import System
import System.Threading.Tasks

async func work() {
    await Task.Delay(1)
    Console.WriteLine("ran")
}

scope {
    work().Wait()
}

Console.WriteLine("done")
```

Expected output:

```text
ran
done
```

Combine `scope` with `using` to make resource lifetimes obvious:

```gsharp
package GSharp.Tour.ScopeUsing

import System
import System.IO
import System.Threading.Tasks

async func ProcessAsync(stream Stream) int64 {
    await Task.Delay(1)
    return stream.Length
}

scope {
    using let stream = MemoryStream([]uint8{1, 2, 3})
    let total = await ProcessAsync(stream)
    Console.WriteLine("total: $total")
}
```

Expected output:

```text
total: 3
```

## What you learned

- `scope { ... }` joins its owned children before returning and observes their failures.
- `async func` integrates with .NET `Task`/`Task[T]` APIs.
- `await` is a prefix expression for allowed async or suspending contexts; see the [concurrency guide](../guide/concurrency.md) for inference and restrictions.
- Awaits compose with loops, nested loops, and ordinary control flow
  with no special handling required.
- `go`, channels, and `select` are language features, not opt-in imports. See [Go-flavored concurrency](../extensions/go-concurrency.md).
