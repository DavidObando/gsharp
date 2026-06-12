---
title: "Concurrency and async"
sidebar_position: 6
draft: false
---

# Concurrency and async

G# has two complementary concurrency models: the **production** model built around `scope` + `async`/`await` with task and iterator state machines, and an opt-in Go-inspired layer of channels, the `go` statement, and `select`.

:::note Go-flavored syntax requires `import Gsharp.Extensions.Go`
The Go-flavored forms — `go`, `chan T`, `<-` (send and receive), `select`, `close(ch)`, and `make(chan T)` — are gated behind a per-file `import Gsharp.Extensions.Go` (ADR-0082, issue #722). Without the import the binder emits [`GS0316`](../ref/diagnostics#go-flavored-concurrency-requires-import-gsharpextensionsgo-gs0316) for each gated form. The gate is **always opt-in**: `/noimplicitimports` does not interact with it. `scope` itself is **not** gated and works on the unannotated language; only the Go-flavored shapes used inside or outside `scope` need the import.
:::

## `go` and `scope`

`go call()` starts a function call concurrently. The binder requires the operand to be a call expression even though the parser accepts any expression. Use `scope` to structure child work: child tasks registered inside the scope are joined at scope exit and failures propagate.

```gsharp
import Gsharp.Extensions.Go

scope {
    go producer(ch)
    go consumer(ch)
}
```

In the interpreter, `go` is implemented with `Task.Run`; outside `scope`, exceptions can be unobserved. Some interpreter evaluation is serialized, so performance characteristics should be validated in emitted programs. The model is documented by [ADR-0002](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0002-concurrency-model.md); the per-file import gate is in [ADR-0082](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0082-gsharp-extensions-go-import.md).

## Channels

Channels are typed with `chan T` and created with `make(chan T)` or `make(chan T, capacity)`. Send uses statement syntax `ch <- value`; receive uses prefix expression `<-ch`. Closing a channel is supported. In the current channel path, receiving after close yields the element default value.

```gsharp title="samples/Channels.gs"
package GSharp.Samples.Channels

import System
import Gsharp.Extensions.Go

let ch = make(chan int32, 3)
ch <- 1
ch <- 2
ch <- 3
close(ch)

let a = <-ch
let b = <-ch
let c = <-ch
let d = <-ch

Console.WriteLine(a)
Console.WriteLine(b)
Console.WriteLine(c)
Console.WriteLine(d)
```

```text title="samples/Channels.golden"
1
2
3
0
```

Channel lowering rationale is in [ADR-0022](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0022-go-chan-select-lowering.md).

## Select

`select` waits over channel operations. The implemented case forms are default, receive and discard, receive and bind, and send.

```gsharp
import Gsharp.Extensions.Go

select {
case let value = <-ch {
    Console.WriteLine(value)
}
default {
    Console.WriteLine("nothing ready")
}
}
```

Use `select` when readiness determines control flow. Keep case bodies short and delegate larger work to functions.

## Async functions and await

`async func` declarations and literals produce task-returning methods in the emit path. `await expr` is a prefix expression and is diagnosed outside async contexts or on non-awaitable operands. Async function type clauses are written `async (P) -> R` (ADR-0075); spelling an explicit task type as the return in that clause is diagnosed because the async marker already supplies the task shape. The legacy `async func(P) R` type-clause spelling continues to parse for one release with the `GS0303` deprecation warning. Async lowering is covered by [ADR-0023](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0023-async-state-machine.md).

## Sequences and async sequences

A function returning `sequence[T]` can use `yield`. `async sequence[T]` is the async sequence type and is consumed with `await for`.

```gsharp
func Numbers() sequence[int32] {
    yield 1
    yield 2
}
```

Sequence design is described in [ADR-0040](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0040-sequence-type-and-yield.md), [ADR-0041](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0041-async-sequence-alias.md), [ADR-0042](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0042-async-sequence-type-clause.md), and [ADR-0043](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0043-async-func-type-clause.md).

## Cleanup and concurrency

`defer` and `using` are scoped constructs. Inside concurrent code, prefer `scope` plus `using` or small deferred cleanup calls so lifetimes are obvious. See [ADR-0030](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0030-defer-and-using-block-scope.md).
