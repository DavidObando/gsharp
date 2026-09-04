---
title: "Go-flavored concurrency"
sidebar_position: 1
draft: false
---

# Go-flavored concurrency

G#'s Go-shaped concurrency primitives — `go`, `chan[T]`, the send and
receive arrows, and `select` — are part of the language (ADR-0174): no
import, no opt-in. They sit on top of the runtime types that ship with .NET
(`Task`, `System.Threading.Channels`) plus a small G#-owned channel runtime,
`Gsharp.Runtime.Channels`, that the SDK references for you.

The structured concurrency surface (`scope`, `async`/`await`,
`async sequence[T]`) is documented in
[Concurrency and async](../guide/concurrency). Use this page when you
want goroutine- and channel-shaped code in a G# project.

:::note Coming from wave 1?
ADR-0174 is a clean-cut break. `chan T` is now `chan[T]` (`GS0567`),
`make(chan T[, n])` is `chan[T]()` / `chan[T](n)` / `Chan.Unbounded[T]()`
and `close(ch)` is `ch.Close()` (`GS0566`), the `len`/`cap`/`append`/`delete`
built-ins are retired for their members (`GS0566`), and
`import Gsharp.Extensions.Go` is gone (`GS0316`/`GS0317` are retired).
Every diagnostic names the replacement for the exact site it fires on.
:::

## Go to G# at a glance

| Go | G# |
| --- | --- |
| `chan T` | `chan[T]` |
| `<-chan T` (receive-only) | `in chan[T]` |
| `chan<- T` (send-only) | `out chan[T]` |
| `make(chan T)` (unbuffered) | `chan[T]()` (rendezvous) |
| `make(chan T, n)` | `chan[T](n)` |
| — (Go has no unbounded channel) | `Chan.Unbounded[T]()` |
| `close(ch)` | `ch.Close()` |
| `len(ch)` / `cap(ch)` | `ch.Length()` / `ch.Capacity` (on a channel you constructed) |
| `v, ok := <-ch` | `let (v, ok) = <-ch` (or `v, ok = <-ch` into existing variables) |
| `for v := range ch` | `for v in ch` |
| `for { v, ok := <-ch; if !ok { break } … }` | `while let v = <-ch { … }` |

## Goroutines with `go`

`go call(...)` starts a function call concurrently. The binder requires
the operand to be a call expression even though the parser accepts any
expression. Use [`scope`](../guide/concurrency#scope--structured-concurrency)
to structure child work: tasks registered inside the scope are joined
at scope exit and failures propagate.

```gsharp title="GoScope.gs"
package GSharp.Samples.GoScope

import System

func send(value int32, ch chan[int32]) int32 {
    ch <- value
    return 0
}

let ch = chan[int32](3)
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

`go { … }` spawns a block directly — the Go idiom `go func() { … }()`
without the ceremony — capturing the enclosing locals, per iteration for a
`for … in` variable:

```gsharp
scope {
    for v in 1 ... 6 {
        go {
            results <- v
        }
    }
}
```

A free `go` outside `scope` is fail-fast: an unhandled exception in it
terminates the process (an unrecovered Go panic), unless the host handles
`Gsharp.Concurrency.GoroutineRuntime.UnhandledGoroutineException`. Prefer
`scope` when the parent operation should observe child failures.

## Channels

Channels are typed `chan[T]` and constructed by applying the type clause to
arguments: `chan[T]()` is a **rendezvous** channel — capacity 0, a send
completes only when a receiver takes the value, exactly Go's unbuffered
channel — and `chan[T](capacity)` is buffered. `Chan.Unbounded[T]()` is the
one unbounded form; it is deliberately the wordiest, because an unbounded
buffer is a memory-leak risk Go does not even offer. Send is a statement
(`ch <- value`); receive is a prefix expression (`<-ch`). `ch.Close()`
closes (closing twice throws, like Go's panic; `Dispose()` is the idempotent
close, so `using let ch = chan[T](n)` works). After a channel is closed and
drained, receiving yields the element type's zero value — with no
exception on the way.

A `chan[T]` converts implicitly to a receive-only `in chan[T]` or a
send-only `out chan[T]`, never the reverse. That is what makes channel
ownership checkable: a producer that returns `in chan[T]` hands out a
handle nobody can close or send on (sending on an `in chan[T]` is
`GS0549`; receiving from an `out chan[T]` is `GS0550`).

```gsharp title="Channels.gs"
package GSharp.Samples.Channels

import System

let ch = chan[int32](3)
ch <- 1
ch <- 2
ch <- 3
ch.Close()

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

`chan[T]` **is** `System.Threading.Channels.Channel<T>` (`in chan[T]` is
`ChannelReader<T>`, `out chan[T]` is `ChannelWriter<T>`), so any channel
coming from C# or a NuGet package flows into a `chan[T]` parameter with no
adapter — and a `chan[T]` can be handed to any C# API that wants a
`Channel<T>`. What `chan[T](…)` constructs is the runtime's
`Gsharp.Concurrency.Chan<T>` subclass, which is where `Length()` (a racy
snapshot, hence a method) and `Capacity` (fixed for the channel's life,
hence a property) live. Foreign channels are supported through the public
reader/writer protocol; only a G#-constructed channel has the rendezvous
guarantee.

## Observable completion: `ok`, `while let`, `for … in`

A single-value receive cannot tell a closed channel from a delivered zero.
The two-value receive can: `let (v, ok) = <-ch` binds the element and
whether the channel delivered it (`ok` is `false` once the channel is
closed and drained). `v, ok = <-ch` assigns two existing variables. Two
loops drain a channel until it is closed — `for v in ch { … }` and
`while let v = <-ch { … }` — and both deliver a `nil` element of a
`chan[T?]` to the body rather than mistaking it for the end (the
`while let` channel clause is keyed on `ok`, not on `nil`, so it does not
strip the element's nullability). In a `while let` with several clauses
the channel clauses gate in source order: a closed channel in the first
clause never receives from the second.

```gsharp title="ChannelOwnership.gs"
package GSharp.Samples.ChannelOwnership

import System

func fill(ch out chan[int32], count int32) {
    for i in 1 ... count + 1 {
        ch <- i * i
    }
    ch.Close()
}

func squares(count int32) in chan[int32] {
    let ch = chan[int32](2)
    go fill(ch, count)
    return ch
}

let source = squares(5)
while let v = <-source {
    Console.WriteLine(v)
}

let (afterClose, ok) = <-source
Console.WriteLine("closed: {0} {1}", afterClose, ok)
```

```text
1
4
9
16
25
closed: 0 False
```

The producer owns the channel — it is the only party that sends and
closes — and hands out an `in chan[int32]` nobody else can close. The
worker-pool (`WorkerPool.gs`) and fan-in (`FanInMerge.gs`) samples build
on the same three pieces: directional parameters, `for job in jobs`, and a
`scope` that joins the workers before the results channel is closed.

## `select` over channel operations

`select` waits on a set of channel operations and runs the first one
that becomes ready.

Cases cover receive (with or without a binding), send, a `default` arm that
runs when nothing is ready, a `Task` arm, and the ambient context's
cancellation. When more than one arm is ready the winner is chosen uniformly
at random, as in Go, so no arm can be starved by its position in the source.

Every arm may carry a `when` guard. It is evaluated once, when the select is
entered, and a false guard keeps the arm out of the select entirely — G#'s
spelling of Go's "set the channel to `nil` to disable this case".

```gs
select {
case let job = <-work when accepting {
    handle(job)
}
case let page = await fetch {
    render(page)
}
case <-after(TimeSpan.FromSeconds(2)) {
    Console.WriteLine("timed out")
}
case cancelled {
    Console.WriteLine("giving up")
}
}
```

`case cancelled` replaces Go's `case <-ctx.Done()`. It needs a context to
observe: an enclosing `scope`, a declared `ctx Context` parameter, or the one
the compiler threads through a suspending call. Without one the arm would be
unreachable, and `GS0557` says so. A select with no such arm unwinds with an
`OperationCanceledException` when its context is cancelled.

```gsharp title="Select.gs"
package GSharp.Samples.Select

import System

let ready = chan[int32](1)
ready <- 7
select {
case let v = <-ready {
    Console.WriteLine("recv: $v")
}
}

let empty = chan[int32](1)
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

`go` lowers to task-based scheduling in the emitted assembly, which is
what every driver (including `gsi`) executes.

A helper that only needs to *suspend* — receive from a channel, send, or
`await` — without handing its caller a `Task` is a
[`suspend func`](../guide/concurrency#suspend-func--suspension-without-a-task):
callers inside another suspending function or an `async func` get the value
directly (the await is implicit), and a channel operation inside any
`async` or suspending body parks the state machine rather than a thread.

Note that G# maps (`map[K,V]`) are backed by plain `Dictionary<K,V>`
with no implicit synchronization, so concurrent access from multiple
goroutines is not goroutine-safe — the same posture as Go maps. For a
map that is meant to be shared across goroutines, use
[`SyncMap[K, V]`](../ref/standard-library#gsharpextensionssync) from
`Gsharp.Extensions.Sync` — its `Update` is an atomic
read-modify-write. For other shared state, `lock` and the
`System.Collections.Concurrent` / `System.Threading` types via CLR
interop are one import away.

## See also

- [Concurrency and async](../guide/concurrency) — the always-available
  `scope` + `async`/`await` surface.
- [Go-style built-ins (retired)](go-builtins) — the replacement table for
  `len`, `cap`, `append`, `delete`, `make`, and `close`.
