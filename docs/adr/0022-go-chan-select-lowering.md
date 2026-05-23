# ADR-0022: `go` / `chan` / `select` → .NET lowering

- **Status**: Accepted
- **Date**: 2026-05-23
- **Phase**: Phase 5 (lock before 5.3)
- **Related**: ADR-0002 (concurrency model), ADR-0023 (async state-machine strategy); execution plan §§5.3 – 5.7

## Context

Per ADR-0002 (D2) GSharp adopts a **synthesis** concurrency model: a Go-shaped surface (`go`, `chan T`, `<-`, `select`) lowered onto .NET primitives, plus first-class `async`/`await` for direct BCL interop. This ADR fixes the lowering targets and the visible semantics that fall out of those choices, so item-by-item work in 5.3 – 5.7 has a single agreed contract.

The interpreter is the source of truth (per the cross-cutting "authoritative-semantics rule"). This ADR therefore documents both:

1. The Go-shaped surface the user sees.
2. The .NET surface the interpreter (and, later, the emitter) lowers to.

## Decision

### `go f(args)` statement

`go` is a **statement** (not an expression). Its operand must be a function-call expression (`go f(args)`, `go obj.Method(args)`, `go lambda()`). Free-standing `go { … }` blocks are not legal — wrap them in a lambda: `go func() { … }()`.

Lowering:

- **Free-standing** (no enclosing `scope`): `go f(args)` lowers to a fire-and-forget `Task.Run(() => f(args))`. The returned `Task` is discarded; unhandled exceptions surface through `TaskScheduler.UnobservedTaskException`, matching Go's "panic in a goroutine" coarseness.
- **Inside a `scope` block** (ADR-0022 §scope): the spawned `Task` is appended to the scope's task list and awaited at scope exit (see §scope below).

A `go` statement targeting an `async func` is legal: the body is already a `Task`, so the lowering becomes `_ = f(args)` (no `Task.Run` wrapper needed) inside a free scope, or registers the returned task with the enclosing `scope` otherwise.

### `chan T` type

`chan T` lowers to `System.Threading.Channels.Channel<T>`.

`make(chan T)` and `make(chan T, capacity)` are recognized as **builtin call expressions** (analogous to existing `len` / `append` builtins):

- `make(chan T)` → `Channel.CreateUnbounded<T>()`
- `make(chan T, capacity)` → `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity))`

`close(ch)` is also a builtin: `ch.Writer.Complete()`. A closed channel surfaces as `<-ch` returning the type's zero / `nil` (and `false` in the two-value form `v, ok := <-ch` — note: two-value receive is **deferred** to Phase 5 polish; this ADR ships single-value receive only).

### Send `ch <- v`

A send is a **statement** (not an expression). Lowering: `ch.Writer.WriteAsync(v).AsTask().GetAwaiter().GetResult()` in synchronous contexts; `await ch.Writer.WriteAsync(v)` in `async` contexts. The binder picks the form based on the enclosing function's `IsAsync` flag.

### Receive `<-ch`

A receive is an **expression** with the channel's element type. Lowering mirrors send: `ch.Reader.ReadAsync().AsTask().GetAwaiter().GetResult()` synchronously; `await ch.Reader.ReadAsync()` inside `async`. If the channel is closed and empty, `ChannelClosedException` is caught and the zero value of the element type is returned (matching Go's `v := <-closedCh` behavior at the surface).

### `select { case … case … default? }`

`select` is a **statement** that orchestrates multiple channel operations:

- `case v := <-ch:` — receive with binding.
- `case <-ch:` — receive, discard.
- `case ch <- expr:` — send.
- `default:` — taken iff no other case is immediately ready.

Lowering strategy (synchronous, interpreter):

1. Snapshot each receive arm's `ch.Reader.WaitToReadAsync()` task and each send arm's `ch.Writer.WaitToWriteAsync()` task.
2. If a `default:` arm is present: also include `Task.FromResult(true)` for immediacy. Otherwise compose with `Task.WhenAny`.
3. After `WhenAny` returns, **re-check each arm in source order** with `TryRead` / `TryWrite` to materialize the winning operation. The first arm that succeeds is taken. If none succeeds (race lost), loop back to step 1 (this preserves fairness across spurious wakeups without livelocking).
4. Execute the body of the winning arm.

In `async` contexts the same algorithm uses `await Task.WhenAny(...)` instead of blocking.

`select { }` (no arms) is a binder error ("`select` with no cases is unreachable").

### `scope { … }` structured concurrency

`scope` is a **statement** that opens a structured-concurrency region. Every `go` issued lexically inside the block is registered with the scope. On scope exit:

- The scope **awaits all registered tasks**.
- If any task threw, the **first** exception is re-thrown after all remaining tasks have either completed or been cancelled. Subsequent failures are attached as `AggregateException.InnerExceptions[1..]` (so users may opt into "see them all" by catching `AggregateException`). This matches Kotlin `coroutineScope`'s "first-fail wins, cooperatively cancel the rest" rather than .NET `Task.WhenAll`'s "wait for everything then report all" semantics.
- A scoped `CancellationTokenSource` is exposed as the implicit `ctx` binding inside the scope (lookup name to be locked in 5.7 implementation; default proposal: `ctx`).
- On the first failure the scope **cancels** its CTS so cooperating tasks can short-circuit.

Lowering: the binder rewrites `scope { … }` into a `BoundScopeStatement` whose body's `go` statements emit into a synthesized `List<Task>` field. The evaluator instantiates `CancellationTokenSource`, runs the body, then awaits the task list and propagates the first exception.

### Receive-via-`for range`

`for v := range ch` is **out of scope for this ADR** (deferred to Phase 7 polish). The Phase-5 surface for iterating a stream is `await for v := range stream` over `IAsyncEnumerable[T]` only (ADR-0023 covers the async piece).

## Consequences

- New `SyntaxKind`s: `AsyncKeyword`, `AwaitKeyword`, `ScopeKeyword`, `GoStatement`, `SelectStatement`, `SelectCase`, `ScopeStatement`, `ChannelSendStatement`, `MakeKeyword` (contextual: `make` is recognized only when followed by `(`), and corresponding bound-node kinds.
- New `TypeSymbol`: `ChannelTypeSymbol[T]` exposing `ElementType`.
- New builtins: `make`, `close`. (Existing `len` / `cap` / `append` pattern.)
- Interpreter takes a runtime dependency on `System.Threading.Channels` and `System.Threading.Tasks`. Both are in the BCL, so no new NuGet refs.
- Emit is **out of scope** for the Phase-5 interpreter PR. The emit gaps are tracked in the coverage matrix and will land in a follow-up "emit parity (Phase 5)" pass.

## Alternatives considered

- **Map `chan T` to `BlockingCollection<T>`** — rejected: no first-class async support; would force every send/recv to block a thread even inside `async` contexts.
- **Generate goroutines as dedicated threads** (one OS thread per `go`) — rejected: doesn't scale, and tying into .NET thread-pool is the path that lets `Task.WhenAny`/`select` work.
- **Defer `select` to Phase 7** — rejected: `select` is the only way to express timeouts and fan-in cleanly; without it the concurrency surface is too thin to justify the rest of Phase 5.
- **Structured concurrency only, no free `go`** — rejected: Go users expect bare `go` to work; we keep both by giving free `go` a clearly worse exception story.

## Open follow-ups

- Two-value receive `v, ok := <-ch` — straightforward once Phase 4 multi-return is fully exercised; track as a Phase-5 polish item.
- `for v := range ch` — covered in Phase 7 alongside `for v in collection`.
- Emit-side state-machine for `select` — likely shares infrastructure with `async`/`await` emit; revisit when ADR-0023's emit decision is final.
