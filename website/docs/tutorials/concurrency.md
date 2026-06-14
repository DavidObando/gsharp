---
title: "Tutorial: Concurrency"
sidebar_position: 5
draft: false
---

# Tutorial: Concurrency

In this tutorial, you will use G#'s always-available concurrency
surface: `scope` for structured concurrency, `async func` and `await`
for task-based asynchrony, and `async sequence[T]` for asynchronous
streams.

The Go-flavored layer — `go`, channels, and `select` — is an opt-in
extension and lives in
[Extensions: Go-flavored concurrency](../extensions/go-concurrency).
Read that page when you specifically want goroutine-shaped code; this
tutorial focuses on the surface that ships unannotated.

## Prerequisites

- A working G# project.
- Basic familiarity with functions and loops.

## 1. Run async work inside `scope`

`scope { ... }` runs its body and waits for every async operation
registered with it before returning. Awaiting inside a scope registers
the awaited task — so unlike a bare `Task.Run` that you forget about,
work inside a `scope` cannot silently outlive its parent.

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

Expected output:

```text
done: a
done: b
after scope
```

If `tick` throws, the exception propagates out of the scope and you can
catch it (or let it bubble) just like any other exception.

## 2. Write an `async func`

`async func` returns a `Task` (for `void`) or `Task[T]` (for a value
return). Inside the body you can `await` any awaitable — most commonly
a `Task` from the .NET BCL:

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
scope {
    using let stream = File.OpenRead(path)
    let total = await ProcessAsync(stream)
    Console.WriteLine("total: $total")
}
```

## What you learned

- `scope { ... }` is the structured-concurrency block: child async work
  is joined before the scope returns, and failures propagate.
- `async func` integrates with .NET `Task`/`Task[T]` APIs.
- `await` is a prefix expression usable only inside async contexts.
- Awaits compose with loops, nested loops, and ordinary control flow
  with no special handling required.
- The Go-flavored concurrency layer (`go`, channels, `select`) is an
  opt-in extension — see
  [Extensions: Go-flavored concurrency](../extensions/go-concurrency).
