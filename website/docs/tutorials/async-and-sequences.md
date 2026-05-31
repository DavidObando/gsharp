---
title: "Tutorial: Async and sequences"
sidebar_position: 6
draft: false
---

# Tutorial: Async and sequences

In this tutorial, you will call .NET `Task` APIs from `async func`, await inside loops, and learn where sequences fit into the language model.

## Prerequisites

- A working G# project.
- Familiarity with `scope` and `go` from [Concurrency](./concurrency).

## 1. Write an async function

An `async func` can await BCL tasks and return a value. A value return is surfaced as a `Task[T]` to callers:

```gsharp title="AsyncTask.gs"
// file: aspirational/AsyncTask.gs
//
// Phase 5 exit sample. Pure async/await interoperating with the BCL `Task`
// surface — `async func` declarations (5.1), `await` (5.1+5.2), and a top-level
// `scope { go runAll() }` (5.7) to drive an async entry point synchronously
// from a script-mode top level. `await Task.Delay(ms)` exercises BCL `Task`
// interop directly. Equivalent shapes work with `Task<T>`-returning APIs
// elsewhere in the BCL.
//
// HttpClient end-to-end interop (constructable imported types, instance member
// access on imported instances) is a Phase-5 polish follow-up — tracked as an
// open item in ADR-0022 §Consequences / coverage-matrix.md. This sample
// demonstrates the *async/await* half of that exit criterion against
// `Task.Delay`; once imported-type construction lands, the same shape applies
// to `HttpClient.GetStringAsync`.

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

scope {
    go runAll()
}

Console.WriteLine("done")
```

Expected output:

```text
a = 6
b = 8
done
```

The top-level script uses `scope { go runAll() }` to drive the async entry point and wait for it before printing `done`.

## 2. Return value types from async functions

The compiler constructs the matching `Task[T]` return type for value-type results such as `int32`, `bool`, and `float64`:

```gsharp title="AsyncValueReturns.gs"
// file: AsyncValueReturns.gs
//
// Regression coverage for issue #290: `async func`s whose kickoff returns a
// VALUE type (so the synthesized return is `Task<T>` for a value `T`) must
// build and run. The bug surfaced only on the SDK build path, where reference
// assemblies are loaded through a MetadataLoadContext and `Task<T>` had to be
// constructed with a type argument projected into that same context. This
// sample exercises int32, bool, and float64 async returns end-to-end.

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

scope {
    go driver()
}

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

The async lowering preserves loop back-edges across suspension points. A loop with one await per iteration runs every iteration:

```gsharp title="AsyncAwaitInLoop.gs"
// file: AsyncAwaitInLoop.gs
// Regression for issue #292: `await` inside a loop body must iterate the loop
// the correct number of times. Previously a single `await` in a `for cond`
// body caused the loop to run only once because the suspension/resume split
// dropped the loop's condition-test back-edge. The async state-machine
// lowering runs over the already-flattened (goto/label) loop form, so the
// resume label sits between the body and the back-edge and every iteration
// re-tests the condition. `Task.Delay` forces a real suspension on each pass.

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
// file: AsyncMultiAwaitInLoop.gs
// Regression for issue #292 (multi-await shape): two `await`s in a single loop
// iteration previously produced a runtime InvalidProgramException because the
// second suspension point's resume label/back-edge structure was malformed.
// A counted `for` with two awaits per iteration locks in deterministic output.

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
// file: AsyncAwaitInNestedLoop.gs
// Regression for issue #292 (nested-loop shape): an `await` in the inner loop
// body, with an additional `await` in the outer loop body, must iterate both
// loops the correct number of times. Exercises multiple distinct resume states
// whose resume labels sit inside two levels of flattened loop back-edges.

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

## 4. Understand sequences

G# has `sequence[T]` for synchronous iterators and `async sequence[T]` for async streams. Iterator functions return a sequence and use `yield`. Async streams are consumed with `await for x in stream` or the legacy `await for x := range stream` spelling. The type-clause forms are part of the current grammar even when a specific sample focuses on async tasks rather than stream construction.

```gsharp
func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}
```

When you need .NET async APIs, use `async func` and `await`. When you need a lazy stream of values, use `sequence[T]` or `async sequence[T]`.

## What you learned

- `async func` integrates with .NET `Task` APIs.
- `await` is a prefix expression inside async functions.
- Async functions returning values surface as `Task[T]`.
- Loop lowering preserves awaits in simple, multiple, and nested loop shapes.
- Sequences use `yield`; async sequences use `await for` when consumed.
