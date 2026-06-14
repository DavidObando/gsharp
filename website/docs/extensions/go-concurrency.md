---
title: "Go-flavored concurrency"
sidebar_position: 1
draft: false
---

# Go-flavored concurrency

`Gsharp.Extensions.Go` is an opt-in extension namespace that surfaces
the Go-shaped concurrency primitives — `go`, `chan T`, send and receive
arrows, `select`, `close`, and `make(chan T, ...)` — on top of the
runtime types that ship with .NET (`Task`, `System.Threading.Channels`).

The always-available concurrency surface (`scope`, `async`/`await`,
`async sequence[T]`) is documented in
[Concurrency and async](../guide/concurrency). Use this page when you
want goroutine- and channel-shaped code in a G# project.

:::note Requires `import Gsharp.Extensions.Go`
The Go-flavored forms are gated behind a per-file
`import Gsharp.Extensions.Go`. Without the import, the binder emits
[`GS0316`](../ref/diagnostics#go-flavored-concurrency-requires-import-gsharpextensionsgo-gs0316)
for each gated form. The gate is always opt-in: `/noimplicitimports`
does not interact with it. `scope` itself is not gated and works on
the unannotated language; only the Go-flavored shapes need the
import.
:::

## Goroutines with `go`

`go call(...)` starts a function call concurrently. The binder requires
the operand to be a call expression even though the parser accepts any
expression. Use [`scope`](../guide/concurrency#scope--structured-concurrency)
to structure child work: tasks registered inside the scope are joined
at scope exit and failures propagate.

```gsharp title="GoScope.gs"
package GSharp.Samples.GoScope

import System
import Gsharp.Extensions.Go

func send(value int32, ch chan int32) int32 {
    ch <- value
    return 0
}

let ch = make(chan int32, 3)
scope {
    go send(1, ch)
    go send(2, ch)
    go send(3, ch)
}

let a = <-ch
let b = <-ch
let c = <-ch
Console.WriteLine(a + b + c)
```

```text
6
```

A free `go` outside `scope` is fire-and-forget and has a weaker exception
story — prefer `scope` when the parent operation should observe child
failures.

## Channels

Channels are typed `chan T` and created with `make(chan T)` (unbuffered)
or `make(chan T, capacity)` (buffered). Send is a statement
(`ch <- value`); receive is a prefix expression (`<-ch`). Closing a
channel is supported via `close(ch)`. After a channel is closed and
drained, receiving yields the element type's default value.

```gsharp title="Channels.gs"
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

```text
1
2
3
0
```

Internally, channels lower to `System.Threading.Channels` — the same
types you would reach for from C#.

## `select` over channel operations

`select` waits on a set of channel operations and runs the first one
that becomes ready. Cases cover receive (with or without a binding),
send, and a `default` arm that runs when nothing is ready.

```gsharp title="Select.gs"
package GSharp.Samples.Select

import System
import Gsharp.Extensions.Go

let ready = make(chan int32, 1)
ready <- 7
select {
case let v = <-ready {
    Console.WriteLine("recv: $v")
}
}

let empty = make(chan int32, 1)
select {
case let v = <-empty {
    Console.WriteLine("unexpected: $v")
}
default {
    Console.WriteLine("default")
}
}
```

```text
recv: 7
default
```

Keep case bodies short and delegate larger work to helper functions so
the readiness logic stays readable.

## Combining `go`, `scope`, and `async`

A scoped goroutine can call an `async func` directly. The scope joins
the returned task, so the body of the scope only completes once the
async work is done.

```gsharp title="AsyncGoScopeJoin.gs"
package GSharp.Samples.AsyncGoScopeJoin

import System
import System.Threading.Tasks
import Gsharp.Extensions.Go

async func work() {
    await Task.Delay(1)
    Console.WriteLine("ran")
}

scope {
    go work()
}

Console.WriteLine("done")
```

```text
ran
done
```

In the interpreter, `go` is implemented with `Task.Run` and some
evaluation is serialized internally; timing behavior may differ from
emitted assemblies. Use emitted builds when reasoning about production
concurrency behavior.

## See also

- [Concurrency and async](../guide/concurrency) — the always-available
  `scope` + `async`/`await` surface.
- [Go-style built-ins](go-builtins) — `len`, `cap`, `append`, `delete`
  ship in the same `Gsharp.Extensions.Go` namespace.
