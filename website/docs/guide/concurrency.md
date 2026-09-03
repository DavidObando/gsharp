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

This guide focuses on the structured surface. The Go-flavored layer
(`go`, `chan[T]`, `select`, `for v in ch`) is part of the language too and
is documented in [Go-flavored concurrency](../extensions/go-concurrency).

## `scope` — structured concurrency

`scope { ... }` runs its body and, before returning, joins every
goroutine started inside it with `go call(...)`. Inside the block an
implicit `ctx` of type `Gsharp.Concurrency.Context` is bound: the first
failing goroutine cancels it immediately, so siblings that observe
`ctx.IsCancelled` (or park on a channel) stop before the join completes.
Exceptions are never dropped:

- the body throws and every goroutine succeeds — the body's exception
  propagates unchanged;
- goroutines fail — the scope throws a `Gsharp.Concurrency.ScopeException`
  (an `AggregateException`) whose `FirstFailure` is the cause and whose
  inner exceptions list every failure in completion order; sibling
  cancellations caused by that failure are not listed;
- both fail — the body's exception is first.

A `scope` is a suspension point: a function containing one is compiled as
a suspending function (see below), so the join parks the state machine
rather than a thread; only the entry point blocks.

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

## `suspend func` — suspension without a task

A `suspend func` is the shape a channel-consuming helper wants: it may
suspend (on a channel operation or an `await`), but callers never see a
`Task`. Inside another suspending function or an `async func` the call is
awaited implicitly and yields the value directly:

```gsharp
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}

suspend func sum(ch in chan[int32], n int32) int32 {
    var total = 0
    for i in 0 ... n {
        total = total + take(ch)   // implicit await; `take` yields int32
    }
    return total
}
```

The emitted method returns `ValueTask[int32]`, so C# callers await it as
usual. `async func` and `suspend func` are never combined on one declaration.

You rarely need to write `suspend`: **suspension is inferred**. A plain
`func` that receives, sends, drains a channel, or calls a function that does
is compiled as a suspending function automatically, so the worker-pool and
pipeline samples read exactly like Go and still park a state machine rather
than a thread. The keyword is for the places inference cannot reach — an
`open` or `override` method, an interface member, a method implementing
one, a function literal — and for library authors who want to pin the
contract. Inside those boundaries a call to a suspending function has nowhere
to await, so it blocks the thread until the callee completes; the compiler
says so with `GS0558`. Top-level statements are the one place that block is
right, so the entry point calls suspending functions silently.

### Timers and fan-in

Two helpers come with the language, by bare name — the namespace they live in is
imported for you:

```gs
select {
case let job = <-work {
    handle(job)
}
case <-after(TimeSpan.FromSeconds(2)) {
    Console.WriteLine("timed out")
}
}

for value in merge(left, right) {
    Console.WriteLine(value)
}
```

`after(d)` fires once; `tick(d)` fires every `d` until you dispose it, so hold
it in a `using let` when you select on it in a loop. `merge` drains every input
concurrently and closes its result once the last input closes; the result is
receive-only, because only `merge` writes to it. Declaring your own `after` or
`merge` shadows these.

### Choosing among more than channels

Three arm shapes cover what Go reaches for other tools to express.

```gs
scope {
    var draining = false
    select {
    case let job = <-work when !draining {
        handle(job)
    }
    case let page = await fetch {
        render(page)
    }
    case cancelled {
        Console.WriteLine("giving up")
    }
    }
}
```

A `when` guard decides once, when the select is entered, whether its arm takes
part at all. A false guard keeps the arm out of the waiter entirely, so it can
never win — this is what Go expresses by setting a channel variable to `nil`.
The guard is evaluated before the arm's binding exists, so it cannot mention
`job`.

`case await task` and `case let v = await task` let a `Task` or `Task[T]` race
the channels on the same waiter. A losing task's continuation is removed when
the select finishes, so a long-running one does not retain it.

`case cancelled` turns the ambient context's cancellation into an arm. Without
it a cancelled select unwinds with an `OperationCanceledException`; with it the
arm runs instead. The arm needs a context to observe — an enclosing `scope`, a
declared `ctx Context` parameter, or the one the compiler threads through a
suspending call — and `GS0557` says so when there is none, because the arm
would otherwise be silently unreachable. Cancellation is consulted only after
the channel arms, so a select that can do its work does it rather than bail
out.

### Spawn now, use later

`go` covers fire-and-forget. When you want the value a child produces, use
`async let`.

```gs
scope {
    async let user   = fetchUser(id)
    async let orders = fetchOrders(id)
    return render(await user, await orders)
}
```

Both fetches start immediately, as children of the block, and run
concurrently. The binding names the result, not a task: `await user` is a
`User`. Reading it a second time returns the completed value without
suspending.

The `await` is required at every use. The read is where the suspension
happens, and this language keeps suspension visible, so a bare `user` is
`GS0569`.

An `async let` needs a `scope` to own it (`GS0551` when there is none), which
is what makes the spawn impossible to leak: the binding is not a value, so it
cannot be stored, returned, or collected. A binding you never read has its
child cancelled at the end of the block and joined there. If that child had
already failed, the failure still reaches the block, so nothing is silently
swallowed. `GS0559` points out that you started work only to cancel it.

A failing `async let` does not cancel its siblings. Catching one child's
failure leaves the others running, which is the difference between `async let`
and a `go` inside the same block.

### Batching, and `chunks`

A channel operation moves one element and pays for one lock acquisition and,
when it has to wait, one park. A data pipeline moving millions of elements
should not pay that per element.

```gs
for batch in chunks(input, 1024) {
    process(batch)
}
```

`chunks(ch, n)` hands over whole buffers: `batch` is a `ReadOnlyMemory[T]` of
up to `n` elements, and the loop is ordinary channel iteration — no extra
goroutine, nothing more for the block to join. A batch arrives as soon as
anything is available rather than waiting to fill, so a producer slower than
the chunk size does not stall the consumer. Each batch owns its array, so a
stage may keep or forward what it was handed.

Underneath it, and available directly, are four operations on a channel
handle:

- `TryReceiveBatch(buffer)` and `TrySendBatch(items)` take a `Span[T]`. They
  never wait, so a borrowed stack view is safe.
- `ReceiveBatch(buffer, atLeast)` and `SendBatch(items)` take a `Memory[T]`.
  They can park, and a destination that survives a park cannot be a `Span`.

`atLeast = 1` is Go's `range` shape, take what is there. `atLeast =
buffer.Length` is a full-fill barrier. Both are legitimate, which is why there
is no default.

A batch that is cut short returns the count it moved rather than throwing: a
closed channel returns what it transferred and reports closed on the next
call, and cancellation mid-batch returns the count so far. A bare throw would
hide that count and a retry would duplicate elements.

Batching a rendezvous channel is pointless — capacity 0 means one value in
flight by definition, so a batch is that many sequential handovers — and
`GS0562` says so.

The slogan is **share buffers by communicating**. Not spans: a borrowed stack
view is exactly the thing that cannot cross a suspension.

### Cancellation

The block's `ctx` is not only for your own checks: every channel operation
inside a `scope` parks on it. When one goroutine fails, its siblings waiting on
a channel unwind with an `OperationCanceledException` instead of waiting
forever, `defer`s run, and the block collapses. An operation that already
completed its transfer keeps its value — cancellation wins only before the
transfer commits, so a receive never drops an element it has already taken.

### Cleanup during cancellation

A `defer` body runs shielded: it does not observe the cancellation that is
unwinding the block, so cleanup that drains a channel or sends a completion
signal still completes instead of being skipped. The shield carries a grace
budget (five seconds by default, `GSHARP_DEFER_GRACE_MS`), so cleanup that
blocks forever cannot hold cancellation up — when the budget expires the
cleanup is abandoned and `GsharpRuntime.DeferGraceExpired` reports it.

### How the context reaches a function

Cancellation follows calls, not just blocks. A suspending function receives the
caller's context as a trailing optional parameter the compiler supplies, so a
receive inside a helper unwinds when the caller's `scope` is cancelled without
either of you writing a parameter. Two cases are yours to steer:

- Write `ctx Context` in the signature when you want it visible — a public API
  whose callers choose the context, or one a C# caller passes to. The compiler
  then uses your parameter and adds nothing.
- A variadic function (`...T`) carries no context, because that parameter must
  stay last and one placed before it could not be skipped by callers. Its
  operations run uncancelled; declare `ctx Context` before the variadic
  parameter when you need cancellation, and callers pass it there.

From C#, a G# suspending function is an ordinary `ValueTask`-returning method:
call it as its signature reads, or pass a `Gsharp.Concurrency.Context` as the
last argument to make it cancellable.

### Debugging and hot reload through suspension

A suspending function is compiled to a state machine, but the tooling keeps the
logical view. Its entry method carries `[AsyncStateMachine]`, so
`Environment.StackTrace`, exception traces, and debuggers show
`Pkg.<Program>.take(…)` rather than `<take>d__1.MoveNext`; the Portable PDB
records where every receive, send, or suspending call yields and resumes, so
stepping over a channel operation that parks lands on the next source line
once the value arrives. Hot reload treats a change to whether a function
suspends as the signature change it is: adding the first channel operation to
a plain `func`, or removing the last one, is rejected with `GSHR1002` naming
the function, and the process must be restarted.

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

## Synchronization and shared state

The first answer to "how do concurrent tasks share state" is the same
as Go's: prefer not to — pass values through channels (or task results)
and let `scope` own the joins.

When sharing is unavoidable, the toolbox is, in order:

1. **`lock`** — a statement that guards a critical section with the
   .NET monitor:

   ```gsharp
   lock guard {
       // critical section
   }
   ```

   The target must be a reference type, is evaluated once, and the body
   runs under `Monitor.Enter`/`Monitor.Exit` with an implicit
   `try`/`finally`. Lock on a private object that never leaves your
   type — never on a value other code can reach.

2. **The BCL via interop** — `ConcurrentDictionary[K, V]`
   (`import System.Collections.Concurrent`) for concurrent maps,
   `Interlocked` for atomic counters, `ReaderWriterLockSlim`,
   `SemaphoreSlim`, and friends (`import System.Threading`).

3. **`SyncMap[K, V]`** (`import Gsharp.Extensions.Sync`) — the
   idiomatic G# shape for a map shared across goroutines, analogous to
   Go's `sync.Map`. It is method-based on purpose: on a shared map
   `m[k] = m[k] + 1` *looks* atomic and races, so compound
   read-modify-write is spelled `Update` and is atomic:

   ```gsharp
   import Gsharp.Extensions.Sync

   func bump(m SyncMap[string, int32]) int32 {
       m.Update("hits", func(v int32) int32 { return v + 1 })
       return 0
   }

   func run() int32 {
       var m = SyncMap[string, int32]()
       scope {
           for var i = 0; i < 50; i++ {
               go bump(m)
           }
       }

       return m.Load("hits")   // exactly 50
   }
   ```

Plain `map[K,V]` is **not** goroutine-safe: it is a bare
`Dictionary<K,V>` with no implicit synchronization, and concurrent
access to one is undefined behavior — the same posture as Go maps. See
the [standard-library reference](../ref/standard-library#gsharpextensionssync)
for the full `SyncMap` API.

## See also

- [Tutorial: Async and sequences](../tutorials/async-and-sequences)
- [Go-flavored concurrency](../extensions/go-concurrency)
  — channels, `go`, `select`, and `ch.Close()`; no import required.
- [Standard library: Gsharp.Extensions.Sync](../ref/standard-library#gsharpextensionssync)
  — the `SyncMap[K, V]` API reference.
