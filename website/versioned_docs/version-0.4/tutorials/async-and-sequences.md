---
title: "Tutorial: Async and sequences"
sidebar_position: 6
draft: false
---

# Tutorial: Async and sequences

In this tutorial, you will call .NET `Task` APIs from `async func`,
`await` inside loops, and learn how `sequence[T]` and
`async sequence[T]` fit into the language.

## Prerequisites

- A working G# project.
- Familiarity with `scope` and `async func` from [Concurrency](./concurrency).

## 1. Write an async function

An `async func` returns a `Task` (or `Task[T]` for a value return). The
body can `await` any `Task`/`Task[T]` from the .NET BCL:

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

Wrapping the call in `scope { runAll().Wait() }` would join the async
work as part of the structured-concurrency block — useful when the
parent operation owns child work that must complete first.

## 2. Return value types from async functions

The compiler constructs the matching `Task[T]` return type for any
value-typed result — `int32`, `bool`, `float64`, and so on:

```gsharp title="AsyncValueReturns.gs"
package GSharp.Samples.AsyncValueReturns

import System
import System.Threading.Tasks

async func asyncInt() int32 {
    await Task.Delay(1)
    return 21 * 2
}

async func asyncBool() bool {
    await Task.Delay(1)
    return true
}

async func asyncFloat() float64 {
    await Task.Delay(1)
    return 3.5 + 1.0
}

async func driver() int32 {
    let i = await asyncInt()
    let b = await asyncBool()
    let f = await asyncFloat()
    Console.WriteLine("i = $i")
    Console.WriteLine("b = $b")
    Console.WriteLine("f = $f")
    return i
}

driver().Wait()
Console.WriteLine("done")
```

Expected output:

```text
i = 42
b = True
f = 4.5
done
```

## 3. Await inside loops

The async lowering preserves loop back-edges across suspension points,
so awaits compose with `for`, `while`, multiple-await iterations, and
nested loops without special handling:

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

Multiple awaits in one iteration also resume correctly:

```gsharp title="AsyncMultiAwaitInLoop.gs"
package GSharp.Samples.AsyncMultiAwaitInLoop

import System
import System.Threading.Tasks

async func loopy() {
    var n = 0
    for n < 2 {
        await Task.Delay(1)
        Console.WriteLine("a $n")
        await Task.Delay(1)
        Console.WriteLine("b $n")
        n = n + 1
    }
}

loopy().Wait()
Console.WriteLine("done")
```

Expected output:

```text
a 0
b 0
a 1
b 1
done
```

Nested loops work the same way:

```gsharp title="AsyncAwaitInNestedLoop.gs"
package GSharp.Samples.AsyncAwaitInNestedLoop

import System
import System.Threading.Tasks

async func loopy() {
    var i = 0
    for i < 2 {
        await Task.Delay(1)
        var j = 0
        for j < 2 {
            await Task.Delay(1)
            Console.WriteLine("i=$i j=$j")
            j = j + 1
        }
        i = i + 1
    }
}

loopy().Wait()
Console.WriteLine("done")
```

Expected output:

```text
i=0 j=0
i=0 j=1
i=1 j=0
i=1 j=1
done
```

## 4. Use `sequence[T]` for synchronous iterators

A function declared to return `sequence[T]` uses `yield` to produce
values lazily; the compiler emits a synchronous iterator that
materializes each value on demand.

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

## 5. Use `async sequence[T]` for async streams

`async sequence[T]` is the asynchronous counterpart — it is the return
type of an `async func`, lowers to .NET's `IAsyncEnumerable[T]`, and is
consumed with `await for`:

```gsharp
package GSharp.Samples.AsyncSequence

import System
import System.Threading.Tasks

async func pulses() async sequence[int32] {
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

Expected output:

```text
1
2
3
```

When you need to call into .NET async APIs, use `async func` and
`await`. When you want a lazy stream of values, use `sequence[T]`
synchronously or `async sequence[T]` for asynchronous pulls.

## What you learned

- `async func` integrates with .NET `Task` APIs.
- `await` is a prefix expression that suspends the surrounding async
  function.
- Async functions returning values surface as `Task[T]`.
- Loop lowering preserves awaits in simple, multiple, and nested loop
  shapes — no special handling required.
- Sequences use `yield`; async sequences are consumed with `await for`
  and interoperate with `IAsyncEnumerable[T]`.
