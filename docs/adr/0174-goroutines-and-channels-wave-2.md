# ADR-0174: Goroutines and channels, wave 2 — suspension over blocking, a G#-owned channel runtime, and observable completion

- **Status**: Proposed
- **Date**: 2026-09-01
- **Phase**: Concurrency wave 2 (language surface + runtime + performance program)
- **Related**: ADR-0002 (concurrency model: Go surface, .NET runtime, Kotlin
  scopes), ADR-0022 (`go`/`chan`/`select` lowering — this ADR completes and
  partly supersedes it), ADR-0023 (async state machines), ADR-0034 (imported
  CLR interop), ADR-0039 (byref and CLR interop), ADR-0082 (`import`-gated
  Go subspace, GS0316/GS0317), ADR-0084 (G#-authored `Gsharp.Extensions`
  packages), ADR-0154 (test-oracle strength / mutant witnesses), ADR-0156
  (emitted-only engine), ADR-0158 (synchronization story; the
  representation-and-magic rule), ADR-0163 (`while let` loop-condition
  bindings), ADR-0168 (mixed deconstruction), ADR-0172 (named tuple
  elements); issue [#3304](https://github.com/DavidObando/gsharp/issues/3304)
  (`go` rejects void operands), issue
  [#2485](https://github.com/DavidObando/gsharp/issues/2485) (actors — still
  open, still not prejudged)

## Context

Wave 1 shipped the Go-shaped surface named in ADR-0002 and lowered in
ADR-0022: `go`, `chan T`, `<-`, `select`, `close`, `make(chan …)`, and
`scope`. The surface is real — it is bound, emitted, ILVerify-clean, and
exercised by `samples/GoScope.gs`, `samples/Channels.gs`, and
`samples/PortScan.gs`.

A pattern study run against the repository on 2026-08-31 took ten canonical
Go concurrency programs and asked how each is written in G# today. The
result is the honest starting point for this ADR:

| # | Pattern | Wave-1 maturity |
| --- | --- | --- |
| 1 | Worker pool | Expressible with caveats |
| 2 | Bounded concurrency | Supported idiomatically |
| 3 | Cancellable pipeline | Awkward workaround |
| 4 | Fan-in merge | Awkward workaround |
| 5 | TTL cache (RW locking) | Expressible with caveats |
| 6 | Keyed token-bucket limiter | Supported idiomatically |
| 7 | Structured-concurrency `All` | Awkward workaround |
| 8 | Timeout wrapper | Expressible with caveats |
| 9 | Channel ownership and routing | Awkward workaround |
| 10 | Atomic counter / lazy init | Supported idiomatically (CLR interop) |

Four of ten are "awkward workaround", and the four are not independent.
Every one of them fails on the same missing capability: **a receiver cannot
tell a closed channel from a channel that delivered a zero value**. Wave 1
maps `ChannelClosedException` to `default(T)`
(`src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs:571-647`), so a
`chan int32` cannot distinguish end-of-stream from a legitimate `0`, and the
corpus works around it by changing every stream protocol to `chan T?` with
`nil` reserved as a sentinel. That is not Go, and it is not a protocol a
library author can impose on a caller.

That is the *expressability* half. The *runtime* half is worse, and it did
not show up in the pattern study because none of the ten programs is large
enough to trip it.

### The three defects, stated precisely

**1. Channel operations block OS threads.** A send emits
`WriteAsync(v).AsTask().GetAwaiter().GetResult()`
(`MethodBodyEmitter.Statements.cs:867-904`); a receive emits
`ReadAsync().AsTask().GetAwaiter().GetResult()` inside a `ChannelClosedException`
handler (`MethodBodyEmitter.Calls.cs:571-647`); `scope` exit emits
`Task.WhenAll(...).GetAwaiter().GetResult()`
(`MethodBodyEmitter.Statements.cs:601-627`); and `select` blocks on
`Task.WhenAny(...).GetAwaiter().GetResult()` in a re-probe loop
(`MethodBodyEmitter.Statements.cs:810-826`). A goroutine is a
`Task.Run` work item (`MethodBodyEmitter.Statements.cs:405-430`), so a
goroutine parked on a channel *occupies a thread-pool thread*.

This is not a performance nit. It is a liveness defect. The spike below
starts 400 goroutines that block on an empty channel, then spawns one more
goroutine. **The new goroutine never runs — measured, 60-second cap, `ran=False`,
375 OS threads.** The equivalent Go program is unremarkable. Any G# program
whose goroutine count exceeds the thread pool's injection rate can deadlock,
and the failure is scheduling-dependent, so it will not reproduce in a unit
test.

**2. Closed-channel detection is exception-based.** Receiving from a closed
channel costs **1949 ns** in wave 1 versus **5.1 ns** in Go — a 382× gap,
paid on the normal termination path of every pipeline stage.

**3. `make(chan T)` is not an unbuffered channel.** It emits
`Channel.CreateUnbounded<T>()` (`MethodBodyEmitter.Calls.cs:508-530`) while
`website/docs/extensions/go-concurrency.md:71-74` documents it as
unbuffered. Code that appears to apply backpressure buffers without a bound.
This is the most dangerous divergence in the surface, because it is silent
and it inverts a memory-safety property.

Alongside these, ADR-0022 §scope specified behavior the emitter does not
implement: the scoped `CancellationTokenSource` is cancelled only *after*
`Task.WhenAll` has already faulted (`MethodBodyEmitter.Statements.cs:551-600`),
so there is no prompt sibling cancellation; the implicit `ctx` binding was
never bound (`StatementBinder.Blocks.cs:923` still carries the
placeholder comment); channel operations pass a freshly constructed default
`CancellationToken` (`MethodBodyEmitter.Calls.cs:676-685`); and `select`
probes all receive arms then all send arms in source order, which is
receive-biased and deterministic rather than Go's uniform-random choice
among ready arms.

### Constraints that bound the solution space

- **.NET 10 ships no stackful green threads.** The runtime-lab green-thread
  experiment was concluded without shipping, and the runtime exposes no
  supported continuation-capture primitive on the target framework. On this
  platform, "a goroutine that parks cheaply" means "an async state machine".
  This is scoped deliberately to .NET 10 as the target: the runtime's ongoing
  runtime-async work may change the calculus later, and D4's inference is
  precisely the layer that would be re-pointed if it does.
- **An *incomplete* `IValueTaskSource`-backed `ValueTask` cannot be
  synchronously consumed.** The narrow, accurate claim: `ValueTask` in general
  *can* be consumed synchronously once complete, and `Task`-backed instances
  can be blocked on. But the `ValueTask` returned by
  `ChannelWriter<T>.WriteAsync` is `IValueTaskSource`-backed, and calling
  `.GetAwaiter().GetResult()` on it before completion is unsupported — the
  spike measured Channels' implementation throwing
  `InvalidOperationException: The asynchronous operation has not completed`.
  The `.AsTask()` in wave 1's lowering is therefore **not removable** while the
  lowering blocks. There is no cheap fix; the fix is to stop blocking.
- **ADR-0158's representation rule.** Syntax-bearing types are
  compiler-known and identity-transparent to their BCL backing
  (`map` ≡ `Dictionary`). Whatever `chan T` becomes must not throw away
  `System.Threading.Channels` interop.
- **ADR-0082's gate.** The Go surface is opt-in per file. Anything this ADR
  adds inherits that gate and costs nothing to programs that do not import it.

### Measured baseline

Spike harness: paired C# and Go programs, .NET 10.0.11 and Go 1.27.0,
Apple silicon, 18 cores, three warm-up rounds for the CLR side (round 3
reported; tiered JIT depresses cold numbers by 2–3×, which is itself a
methodology requirement for D11). "G# today" reproduces the exact call
sequence the emitter produces.

| Scenario | G# today | Best CLR measured | Go 1.27 | Verdict |
| --- | --- | --- | --- | --- |
| Buffered chan, SPSC, cap 64, 1M items | 54.4 ns/op | 44.9 ns/op | **25.5 ns/op** | 2.1× behind |
| Chunked transport, 64/chunk | — | 6.8 ns/op | **3.6 ns/op** | 1.9× behind |
| Chunked transport, 1024/chunk | — | 2.9 ns/op | **0.7 ns/op** | 4× behind |
| Ping-pong round trip — G# on `make(chan T, 1)`, Go on an unbuffered chan | 1158 ns/op | — | **219 ns/op** | 5.3× behind, on the *easier* primitive (see note) |
| Receive from closed channel | 1949 ns/op | **4.4 ns/op** | 5.1 ns/op | 382× behind; fixable to parity |
| Goroutine spawn — *queueing cost only* | 358 ns (`Task.Run`) | **220 ns** (`UnsafeQueueUserWorkItem`) | 202 ns | parity reachable on this component |
| `select`, 2 ready arms — *fast path only* | **30.7 ns/op** | — | 53.3 ns/op | not comparable as-is (see note) |
| 200 000 parked receivers — *shallow frame* | *cannot* | **384 B each**, 400 ms | 2669 B each, 407 ms | 7× less memory at this depth |
| 400 blocked receivers, then spawn one more | **never scheduled (>60 s)** | n/a (suspension) | n/a | correctness failure |

Four rows carry caveats that must not be lost when they are quoted:

- **Ping-pong.** Wave 1 has no rendezvous channel at all (defect 3), so there
  is nothing to measure. The G# number is a capacity-1 bounded channel, which
  is *strictly easier* than Go's unbuffered rendezvous — a cap-1 send may
  complete before a receiver arrives. The 5.3× gap is therefore a lower bound
  on the real rendezvous gap, not a measurement of it. A true rendezvous
  baseline must be built in Phase 1 before the D11 budget is meaningful.
- **`select`.** Both sides were fast-path dominated over pre-filled channels,
  and G# probes arms deterministically in source order while Go randomizes.
  The 30.7 ns is partly *measuring the semantic divergence D8 removes*. The
  parking path — the one that matters under contention — was never isolated.
  This row is not evidence for a post-D8 budget.
- **Spawn.** 220 ns is raw queueing. It excludes argument capture,
  state-machine construction, context plumbing, scope registration, completion
  observation, and exception handling — all of which D4/D5/D6 add.
- **Parked memory.** 384 bytes is one shallow suspended frame. D4's honest
  cost is that G# holds a box per suspended *frame* while Go holds one
  growable stack per goroutine; a deep suspending call chain narrows or
  reverses this. The row supports "shallow parked goroutines are cheaper", not
  a general claim about service capacity.

Two conclusions follow, and both shape the decision.

First, **the gap to Go on per-message channel throughput is real but modest
once the self-inflicted costs are removed** — 1.8–2.1×, not 10×. Go's
advantage is its bespoke scheduler and 2 KB stacks, and no managed
implementation is going to erase it. A naive hand-written Go-style `hchan`
(ring buffer, FIFO waiter queues, pooled `IValueTaskSource` waiters) was
built in the spike and measured **105.8 ns/op — worse than the BCL
channel**. The bottleneck is park/unpark and scheduler hand-off, not the
queue data structure. Rewriting the queue is not the lever.

Second, **G# has a structural memory advantage at shallow park depth and can
reach parity on spawn and closed-receive.** A shallow suspended state machine
is smaller than a 2 KB goroutine stack. Spawn reaches parity with the right
primitive. Closed-channel receive goes from 382× behind to parity by deleting
an exception handler. The `select` and rendezvous positions are *unknown*
rather than favorable, for the reasons noted above.

The honest target for "perform as good or better than equivalent Go code" is
therefore **not** a blanket claim, and it is not yet a measured one. It is a
per-scenario budget — provisional until Phase 1 rebuilds the baseline against
semantics-equivalent implementations, then ratcheted in CI (D11).

## Decision

Eleven decisions. D4 is the load-bearing one; the rest are either
prerequisites for it or the expressability work it unblocks.

### D1 — `chan T` stays `Channel<T>`; `make` constructs a G#-owned `Chan<T>` derived from it

A new C#-authored assembly, **`Gsharp.Runtime.Channels`**, packaged and
referenced by the SDK exactly as `Gsharp.HotReload.Runtime` already is
(`src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj:152-168`,
`build/Gsharp.NET.Core.Sdk.targets:36-39`). It contains:

```csharp
public sealed class Chan<T> : System.Threading.Channels.Channel<T>, ISelectable<T>
```

The split that matters:

| | CLR type |
| --- | --- |
| **The type `chan T` binds to** | `System.Threading.Channels.Channel[T]` — unchanged from wave 1 |
| **The type `make(chan T, …)` constructs** | `Gsharp.Runtime.Channels.Chan[T]` |

This is deliberate, and it is a correction to an earlier draft of this ADR
that bound `chan T` to the concrete `Chan[T]`. Binding the *type* to the
subclass buys nothing and costs inbound interop: a foreign `Channel[T]` from
C# or NuGet would no longer be assignable to `chan T`. Binding the type to
`Channel[T]` and the *constructor* to `Chan[T]` keeps ADR-0158's identity
rule literally intact — `chan T` **is** `Channel<T>`, the way `map` **is**
`Dictionary` — while still letting every channel G# creates carry the extra
machinery.

Operations dispatch accordingly: the emitter emits a type test, takes the
fast path through `ISelectable[T]` when the instance is a `Chan[T]`, and
falls back to the documented public `ChannelReader`/`ChannelWriter` protocol
otherwise (matrix in D2). The fast path is the overwhelmingly common one,
because it covers every channel created by `make`.

Semantics of a `Chan[T]` become Go-exact:

| Form | Semantics |
| --- | --- |
| `make(chan T)` | **capacity 0 — a rendezvous channel.** A send completes only when a receiver takes the value. |
| `make(chan T, n)` | ring buffer of capacity `n`, FIFO |
| `close(ch)` | subsequent sends throw `ChannelClosedError`; receives drain, then yield `(zero, false)` forever |
| `close` of a closed or `nil` channel | throws (Go panics) |
| send/receive on a `nil` channel | blocks forever (Go parity — this is what makes disabled `select` arms work) |
| `len(ch)` / `cap(ch)` | buffered count / capacity — only defined on `Chan[T]` |

**Memory model.** "Go-exact" is a claim about visibility, not just about
queue behavior, so it is stated normatively:

- A send that commits *happens-before* the receive that takes its value.
  Writes made by the sending goroutine before the send are visible to the
  receiving goroutine after the receive. This is Go's guarantee and it is what
  makes "share memory by communicating" safe for reference payloads.
- For a rendezvous channel, Go additionally guarantees that the *receive*
  happens-before the *send completes*. `Chan[T]` matches this; a capacity-1
  bounded channel does not, which is why D1 cannot be built on
  `Channel.CreateBounded(1)`.
- `close(ch)` happens-before a receive that observes closed-and-drained.
- `len(ch)` and `cap(ch)` are **snapshots**. `len` carries no synchronization
  guarantee and is racy by construction; it is diagnostic, not a control-flow
  primitive. This matches Go and is documented as such rather than left to be
  discovered.

**Why C#-authored rather than G#-authored.** Unlike `SyncMap` (ADR-0158,
zero compiler changes, ordinary G# surface), this assembly is *emitted into*
and lives on the hot path: it needs `IValueTaskSource`,
`ManualResetValueTaskSourceCore`, `[MethodImpl(AggressiveInlining)]`,
`Interlocked`, and `Memory<T>` marshalling in tight loops. It is compiler
infrastructure, not a user-facing library, and it must not participate in the
`Gsharp.Extensions` bootstrap cycle.

### D2 — `in chan T` / `out chan T` map onto `ChannelReader<T>` / `ChannelWriter<T>`

```gsharp
func produce(ch out chan int32) { … }       // send-only
func consume(ch in chan int32) { … }        // receive-only
func both(ch chan int32) { … }              // bidirectional
```

| G# type | CLR type |
| --- | --- |
| `chan T` | `System.Threading.Channels.Channel[T]` |
| `out chan T` | `System.Threading.Channels.ChannelWriter[T]` |
| `in chan T` | `System.Threading.Channels.ChannelReader[T]` |

Go's arrow spellings (`<-chan T` / `chan<- T`) are deliberately **not** kept.
They are the shape a Go reader recognizes instantly, but they read as line
noise to the Swift/Kotlin/C# half of the audience, they collide visually with
the receive operator `<-ch` in a way that hurts scanning, and G# already has
`in`/`out` as variance keywords (ADR-0021). Reusing them here means
directionality is spelled the same way everywhere in the language, and the
mapping to `ChannelReader`/`ChannelWriter` is self-evident: `in` is what you
read from, `out` is what you write to.

The Go-to-G# bridge documentation carries the translation explicitly, since
this is the one place in the channel surface where a Go programmer must
re-learn a spelling rather than recognize one:

| Go | G# |
| --- | --- |
| `<-chan T` | `in chan T` |
| `chan<- T` | `out chan T` |
| `chan T` | `chan T` |

**Grammar note.** `in` and `out` are already keywords: ADR-0021 uses them for
declaration-site variance *inside type-parameter brackets* (`interface
Func[in TArg, out TResult]`), and `in` heads the `for … in …` loop. Neither
collides — a channel direction appears only in **type position**, where
neither of the others can. Phase 2 must nonetheless cover the one genuinely
confusable line, `for v in ch`, against a parameter declared `ch in chan T`,
in the parser tests.

Implicit conversions `chan T` → `out chan T` and `chan T` → `in chan T`
exist; the reverse does not. This is what makes pattern 9 (channel ownership
and routing) expressible: a producer returns `in chan T` and no caller can
close it.

It also preserves *inbound* interop: any BCL `ChannelReader<T>` — from
`Channel.CreateUnbounded`, from a NuGet library, from C# — **is** a G#
`in chan T` with no adapter, and any `Channel<T>` **is** a `chan T`.

**Operation matrix.** Not every operation survives every representation, and
pretending otherwise is how silent misbehavior gets shipped. This table is
normative:

| Operation | `Chan[T]` (from `make`) | Foreign `Channel[T]` | Foreign `ChannelReader[T]` | Foreign `ChannelWriter[T]` |
| --- | --- | --- | --- | --- |
| send `ch <- v` | fast path | `WriteAsync` | — | `WriteAsync` |
| receive `<-ch` | fast path | fallback loop | fallback loop | — |
| two-value `v, ok = <-ch` | fast path | fallback loop | fallback loop | — |
| `for v in ch` | fast path | `ReadAllAsync` | `ReadAllAsync` | — |
| `close(ch)` | Go semantics (double-close throws) | `TryComplete()`; **double-close does not throw** | — | `TryComplete()` |
| `len(ch)` / `cap(ch)` | supported | **GS0559** | **GS0559** | **GS0559** |
| batch (D10) | fast path | element-wise fallback | element-wise fallback | element-wise fallback |
| `select` arm | registered waiter | `WaitToRead/WriteAsync` + re-probe | same | same |
| rendezvous guarantee | yes | **no** | **no** | **no** |

The **fallback loop** is `WaitToReadAsync()` → `TryRead(out v)`, *repeated*.
The repetition is required, not incidental: `WaitToReadAsync` completing does
not reserve an item, so a competing consumer can take it first. A single
`WaitToReadAsync` + `TryRead` is a lost-wakeup bug.

Two foreign-channel behaviors are called out because they are not
recoverable:

- **Faulted completion.** A foreign writer may call `TryComplete(exception)`.
  G# surfaces that as a thrown exception from the receive, *not* as an
  ordinary close returning `(zero, false)` — losing a fault silently is worse
  than a surprise throw. `Chan[T]` never faults; `close` is the only
  completion it has.
- **No rendezvous.** A foreign channel cannot provide Go's receive-before-
  send-completes guarantee, and G# does not pretend it can.

### D3 — Observable completion: four surfaces, one primitive

This is the highest-leverage expressability gap, and it moves patterns 1, 3,
4, and 9 from "awkward workaround" to idiomatic. Everything lowers to two
runtime primitives on `Chan[T]`:

```csharp
public readonly struct ReceiveResult<T> { public readonly T Value; public readonly bool Ok; }

bool TryReceive(out T value, out bool ok);                      // non-blocking fast path
ValueTask<ReceiveResult<T>> ReceiveAsync(CancellationToken ct); // suspending
```

The suspending form **must** return the value in its result, not through an
`out` parameter. An `out` argument is written before the method returns; a
receive that parks produces its value after that point, and retaining a
managed reference to the caller's storage across a suspension is not valid on
the CLR. `ReceiveResult<T>` is a readonly struct so the fast path stays
allocation-free.

`TryReceive` reports three states in two `bool`s, and the encoding is
normative: `(true, true)` — a value; `(true, false)` — closed and drained,
`value` is the zero; `(false, _)` — nothing available *right now*, channel
still open. Only the third state requires suspending.

**(a) Go-parity two-value receive**, using the existing multi-target binding
machinery (ADR-0015, ADR-0168):

```gsharp
let value, ok = <-jobs
if !ok {
    return
}
```

**(b) `while let` over a channel** — the idiomatic G# form, and the one that
makes this feel like G# rather than a Go transcription:

```gsharp
while let job = <-jobs {
    results <- process(job)
}
```

ADR-0163 requires a `while let` initializer to have nullable type `T?`
(GS0296). A channel receive is a deliberate, narrow carve-out: it is
*completion-bearing*, so the loop is governed by `ok`, not by nullability.
`while let v = <-ch` therefore works for `chan int32` — no `chan int32?`, no
reserved sentinel. This is the single change that retires the `nil`-sentinel
protocol from the corpus.

Three consequences of the carve-out are normative, because getting them wrong
would silently corrupt data:

- **No nullable stripping.** For `chan T?`, the bound variable is `T?`, not
  `T`. Receiving a legitimate `nil` is a *successful* receive and **must**
  execute the loop body. This is the exact inverse of ADR-0163's normal rule,
  and it is the reason the carve-out has to be explicit rather than emergent:
  under ADR-0163's semantics a received `nil` would silently terminate the
  loop.
- **Short-circuit evaluation.** ADR-0163 evaluates every header initializer
  before the combined test. A multi-clause `while let a = <-x, let b = <-y`
  under that rule would receive from `y` even after `x` reported closed —
  blocking forever, or worse, consuming a value and discarding it. Channel
  receives in `while let` therefore **short-circuit**: the first clause that
  reports completion ends the loop and no later clause is evaluated. This is a
  deviation from ADR-0163 and is called out in that ADR's follow-up.
- **The form is recognized syntactically**, on the receive operator, not
  inferred from the operand's type. `while let v = <-ch` is the channel form;
  `while let v = f()` is ADR-0163's form even if `f` returns a channel
  element. GS0555 fires when the two are confused.

An earlier draft left all three implicit. They are the difference between a
carve-out and a trapdoor.

**(c) `for … in` over a channel** — Go's `for v := range ch`:

```gsharp
for job in jobs {
    results <- process(job)
}
```

The binder extends the existing for-in element protocol
(`StatementBinder.Loops.cs:20-74`, which already recognizes `sequence[T]`,
`IEnumerable[T]`, `IAsyncEnumerable[T]`, …) with a channel case. Iteration
ends when the channel is closed and drained.

**(d) `len(ch)` and `cap(ch)`**, gated with the other Go builtins.

The single-value form `<-ch` keeps Go's semantics — the element's zero value
on a closed channel — but delivers it **without an exception**, which is the
382× fix.

The worker pool (pattern 1) becomes, in full:

```gsharp
package Example.WorkerPool

import Gsharp.Extensions.Go

func worker(jobs in chan Job, results out chan Result) {
    for job in jobs {
        results <- process(job)
    }
}

func run(jobs in chan Job, workers int32) in chan Result {
    let results = make(chan Result)
    go func() {
        scope {
            for i in 0 ... workers {
                go worker(jobs, results)
            }
        }
        close(results)
    }()
    return results
}
```

That is the Go program, with `scope` standing in for `sync.WaitGroup` and
directional types making the ownership rule checkable.

### D4 — Suspension, not blocking: goroutine-reachable functions are compiled as state machines, and the coloring is *inferred*

**A channel operation is a suspension point.** Any function that performs
one — directly, or transitively through a call — is compiled as an async
state machine and parks without holding a thread.

**The coloring is inferred where it can be, and declared where it must be.**
`func` stays colorless in the code a Go programmer actually writes — function
bodies, local helpers, lambdas, private module functions. This is the decision
that makes the surface *behave* like Go rather than merely look like it, and
it is what distinguishes G# from its neighbours: Kotlin makes you write
`suspend` everywhere, C#/Python/Swift make you write `async` everywhere, Go
has no coloring at all and pays for it with a bespoke runtime. G# infers what
Kotlin declares — up to the boundary where inference stops being sound.

#### The ABI

`[Suspending]` is a *label*. It cannot make a CLR call suspend. The emitted
signature has to change, and this ADR states exactly how:

| Source form | Emitted CLR signature | Call site in G# | Seen from C# / reflection |
| --- | --- | --- | --- |
| non-suspending `func f() R` | `R f()` | ordinary call | `R f()` |
| **inferred**-suspending `func f() R` | `ValueTask<R> f()`, `[Suspending]`, `[PoolingAsyncValueTaskMethodBuilder]` | **implicitly awaited** | `ValueTask<R> f()` — visible, and that is accepted |
| explicit `async func f() R` | `Task<R> f()` (ADR-0023, unchanged) | returns `Task[R]`; `await` to get `R` | `Task<R> f()` |

Three points follow, and they are the whole contract:

1. **Adding a channel operation to a function changes its emitted CLR
   signature.** This is a binary-breaking change to that function. There is no
   way around it on this platform, so the ADR makes it visible rather than
   surprising — which is precisely why inference is capped at the boundaries
   below.
2. **`R` is the logical G# return type**, recorded in metadata alongside
   `[Suspending]`. G# call sites type the call as `R` and insert the await;
   overload resolution, inference, and diagnostics all use `R`.
3. **The two spellings are not unified into one representation.** An earlier
   draft claimed `async func` was "the same mechanism with two spellings".
   That was wrong: `async func` has an *observable* `Task` that the caller may
   store, race, or hand to a BCL API, and implicitly awaiting it would destroy
   Task composition and contradict ADR-0023. Inferred suspension has no
   observable task by construction. They are two mechanisms that share the
   state-machine emitter.

Calling an `async func` does **not** by itself make the caller suspending;
only `await` does. The normative table:

| Expression | Caller becomes suspending? | Type of the expression |
| --- | --- | --- |
| `ch <- v`, `<-ch`, `select`, channel `for..in` | **yes** | per operation |
| call to an inferred-suspending `f()` | **yes** | `R` |
| call to `async func g()` | no | `Task[R]` |
| `await g()` | **yes** | `R` |
| `go g()` | no | — |
| call to an ordinary function returning `Task[R]` | no | `Task[R]` |

#### Where inference stops

Inference is a per-assembly fixed point over the call graph (SCC-based, so
mutual recursion converges). Three different kinds of boundary limit it, and
they need to be told apart — an earlier draft lumped them together and
concluded, wrongly, that public functions cannot be inferred:

**(i) Soundness boundaries — inference is impossible, declaration required.**

| Construct | Why |
| --- | --- |
| virtual / abstract / interface declarations | the implementation is chosen at run time. One implementation's use of a channel cannot retroactively color a slot that other implementations and all call sites already committed to. GS0552. |
| function-typed parameters and returns | a generic `apply(f)` is compiled once. Suspendability must live in `f`'s *type* — `async (T) -> R` (`Parser.TypeClauses.cs:571-595`) — or it cannot be represented at all. GS0553. |

**(ii) Representability boundaries — suspension is forbidden outright.**

Constructors, property and event accessors, static initializers, operators,
finalizers, `Dispose`, and synchronous iterators (`sequence[T]`). None has a
task-like return position, so the caller has nowhere to await. GS0561; the
message points at `async sequence[T]` for the iterator case.

**(iii) Versioning boundaries — inference works, but the contract moves.**

Ordinary non-virtual `public` functions **are** inferred. Separate
compilation stays sound: assembly A's inference runs, `f` emits
`ValueTask[R]` with `[Suspending]`, and assembly B reads that from metadata
without re-running any analysis. The hazard is not unsoundness, it is
*versioning*: adding a channel operation to a published `f` changes its
signature, exactly as changing its return type would.

This distinction matters more in G# than it would elsewhere, because ADR-0006
makes top-level declarations `public` **by default**. Treating public as a
declaration boundary would have forced `suspend func` onto essentially every
Go-shaped example in this document, which is precisely the ergonomic loss D4
exists to avoid. So:

> **GS0560 is a warning** on a public function that became suspending by
> inference, suggesting an explicit `suspend func` to pin the contract. It is
> an **error** only under the strict-API opt-in a library with a stable
> published surface would enable.

Application code keeps the Go shape. Library authors get told, once, where
their ABI is now load-bearing.

| Construct | Inference |
| --- | --- |
| private / file-local / local functions / lambdas | inferred, silently |
| direct calls, including mutual recursion | inferred (SCC fixed point) |
| non-virtual `public` functions | inferred; GS0560 warning (error under strict API) |
| virtual / abstract / interface declarations | **declared** — GS0552 |
| function-typed parameters and returns | **declared in the type** — GS0553 |
| constructors, accessors, static init, operators, `Dispose`, sync iterators | **forbidden** — GS0561 |
| reflection / dynamic invocation | not analyzed; invoking a suspending method reflectively yields the `ValueTask`, documented rather than hidden |

**The override rule, correctly stated.** An earlier draft gave only half of
it. Both halves are required:

- a suspending override **cannot** implement a non-suspending declaration
  (GS0552) — the virtual slot's signature has no task-like return;
- an override of a **suspending** declaration **retains the suspending ABI**
  even if its own body never suspends. The slot's signature is fixed by the
  declaration, not by the implementation.

This is the same rule Kotlin enforces for `suspend`, for the same reason: the
call site must know, and it only sees the declaration.

**`suspend func` is the declaration form** for the boundary cases above: a
function that is suspending, with no observable task, declared rather than
inferred. It is `async func`'s sibling — same state machine, no `Task`. Go
programmers writing ordinary pipeline code never type it; library authors
exporting a channel-consuming API do.

#### Builders and roots

- A suspending function whose task is never observed — every goroutine body,
  every inferred-suspending call — uses `PoolingAsyncValueTaskMethodBuilder`.
  Spike-measured at **~0 bytes per invocation** in steady state, so a
  saturated pipeline allocates no state-machine boxes. The honest qualifier:
  pooling is *amortized* avoidance under bounded reuse, not a guarantee that
  no box is ever allocated; the pool has a bounded size and overflows to
  ordinary allocation.
- A pooled `ValueTask` **must be consumed exactly once**. D5 defines the
  completion sink that guarantees this.
- `async func` keeps `AsyncTaskMethodBuilder` (ADR-0023,
  `StateMachineEmitter.cs:1689-1703`).
- **Root boundary.** The synthesized entry point and any explicit sync
  boundary block once, at the root, where blocking is correct (GS0558 warns
  elsewhere).

The measured justification is the starvation result: today, 400 parked
goroutines prevent a 401st from ever running. Under D4 the same program parks
400 state machines at 384 bytes each and schedules the 401st immediately.
This is the decision that turns G# channels from a demo into infrastructure.

**Honest cost.** Go keeps one growable stack per goroutine; G# will hold one
state-machine box per suspended *frame*. A deeply nested suspending call
chain costs more in G# than in Go, and the 7× memory advantage measured at
depth 1 narrows with depth. In exchange, a shallow parked goroutine — the
common case in pipelines and servers — is much cheaper. D11 measures both, at
several depths.

### D5 — `go` lowers to a work item, not a `Task`

`go f(args)` emits the synthesized closure **as** an `IThreadPoolWorkItem`
and dispatches it with
`ThreadPool.UnsafeQueueUserWorkItem(item, preferLocal: true)`:

- no `Task` allocation, no delegate allocation;
- `preferLocal` puts the goroutine on the spawning thread's local queue. It is
  a *placement hint*, not an equivalent of Go's prioritized `runnext` slot —
  an earlier draft claimed parity it does not have;
- measured **220 ns vs `Task.Run`'s 358 ns vs Go's 202 ns** for the queueing
  component alone.

**Evaluation order.** The function value and all arguments are evaluated on
the spawning goroutine, *before* the work item is queued — Go's rule, and the
one that makes `go f(i)` inside a loop capture the current `i`.

**Completion sink.** Every goroutine has exactly one, and it consumes the
body's pooled `ValueTask` exactly once. "The task is never observed" is not a
policy; an unconsumed pooled `IValueTaskSource` leaks its result, defeats
pooling, and drops exceptions.

| Goroutine kind | Sink | On exception |
| --- | --- | --- |
| scoped (`go` inside `scope`) | the scope frame: decrement the interlocked pending counter, record the failure, cancel siblings | first failure propagates from `scope` exit (D6) |
| free (`go` at top level) | a runtime-owned sink | **fail-fast by default** — the exception is surfaced on the unhandled path, matching Go's "an unrecovered panic kills the program". A `Runtime.UnhandledGoroutineException` hook allows a host to observe or override. |

An exception must **never** escape `IThreadPoolWorkItem.Execute` — that path
can terminate the process at a point the runtime cannot attribute. The
synthesized work item wraps the body and routes every fault to the sink.

**Registration before queueing.** A scoped goroutine increments the scope's
pending counter *before* `UnsafeQueueUserWorkItem`, never after; the reverse
order races a fast child to completion before the scope knows it exists.

**`ExecutionContext` is not flowed** — this is a deliberate, breaking
semantic change from wave 1's `Task.Run`. `AsyncLocal[T]`, `Activity` (and
therefore distributed tracing), `CultureInfo`, and `ClaimsPrincipal` do
**not** propagate into a goroutine. D7's context is a G#-specific channel for
cancellation only and replaces none of them. This is recorded as breaking
change #7; Phase 3 must measure an explicitly-captured minimal context before
the isolation is locked in, because tracing continuity is worth more than
20 ns to many hosts.

Scope registration becomes an interlocked pending counter on the scope frame
rather than `List<Task>.Add` plus `ToArray()` at exit
(`MethodBodyEmitter.Statements.cs:395-404, 601-608`).

`go` accepts void-returning operands, closing
[#3304](https://github.com/DavidObando/gsharp/issues/3304) and deleting the
`return 0` that every goroutine in the corpus currently carries.

### D6 — `scope` is completed to its ADR-0022 specification

`scope` becomes the single answer to `sync.WaitGroup`, `errgroup`, and
`context.WithCancel`:

- **implicit `ctx` binding**, of type `Context` (D9), finally binding the
  placeholder at `StatementBinder.Blocks.cs:923`;
- **prompt sibling cancellation**: the scope cancels its token *on the first
  failure*, before awaiting the remaining children — not after `WhenAll` has
  already faulted, which is what happens today
  (`MethodBodyEmitter.Statements.cs:551-600`);
- **failure propagation with a representable shape**: `scope` exit throws a
  `ScopeException` whose `InnerException` is the first failure and whose
  `InnerExceptions` lists all of them, first at index 0. An earlier draft said
  "rethrow the first, attach the rest as `AggregateException.InnerExceptions[1..]`",
  which is not expressible — an existing exception cannot acquire an inner
  list after construction. `ScopeException` derives from `AggregateException`,
  so existing `catch (AggregateException)` handlers still work;
- **exception precedence**, stated so it is not discovered by experiment:

  | Situation | What `scope` throws |
  | --- | --- |
  | body throws, children succeed | the body's exception, unwrapped |
  | children fail, body succeeds | `ScopeException`, children in completion order |
  | both fail | `ScopeException` with the **body's** exception at index 0 |
  | only cancellation, from an outer scope | `OperationCanceledException` — cancellation is not a failure |
  | only cancellation, self-inflicted by a child failure | `ScopeException` with the *causing* failure at index 0; sibling `OperationCanceledException`s are **discarded**, not listed |
  | a `defer` throws during unwind | it wins, with the original as its `InnerException` (CLR convention) |

- **cheap join**: an interlocked pending counter plus one completion waiter,
  no `List<Task>`, no `Task[]`, no `Task.WhenAll`;
- **suspending exit**: in a suspending context the scope awaits; only the
  root blocks.

Pattern 7 (`All` with first-error and sibling cancellation) becomes `scope`
with no user-written bookkeeping at all.

### D7 — Channel operations are cancellation points

Every channel operation observes the ambient scope context. Cancellation
**unwinds** — it throws, `defer`s run, the scope collapses — rather than
returning a sentinel. This is Kotlin's and Swift's structured-concurrency
behavior and the CLR's `OperationCanceledException` convention, and it is
strictly better than Go's requirement to hand-write
`select { case <-ctx.Done(): return }` at every blocking point.

**The linearization rule.** Cancellation racing a transfer is where a naive
implementation silently loses or duplicates data, so the commit point is
normative:

> Cancellation wins **only before the transfer commits**. Once an operation
> has committed, it succeeds, and the cancellation is observed by the *next*
> operation.

Concretely:

- a send that has been enqueued into the buffer, or has rendezvoused with a
  receiver, **reports success** even if cancellation arrives before its
  continuation runs;
- a receive that has removed an item from the buffer **returns that item**
  rather than throwing and dropping it;
- a batch operation that transferred *k* of *n* elements returns *k* — it
  never throws a bare `OperationCanceledException` that would leave the caller
  unable to tell how much moved and invite duplicates on retry (D10);
- only an operation still parked, with nothing transferred, throws.

**Cleanup shielding.** `defer`s run during cancellation unwind — and deferred
cleanup very often needs a channel (draining, sending a completion signal,
returning a pooled buffer). Under a naive reading, every such operation would
immediately observe the already-cancelled context and throw, so cleanup would
be silently skipped and the primary failure replaced by a cancellation. So:

> A `defer` body executes under a **shielded** context: cancellation-immune,
> with a bounded grace budget.

If the grace budget expires the cleanup is abandoned and a diagnostic is
raised on the runtime hook; the budget exists so a cleanup that itself blocks
forever cannot make cancellation unresponsive. If a `defer` throws, it wins
over the exception being unwound, with that exception as its
`InnerException` — the CLR convention, and the same rule as D6's table.

**How the context reaches the operation.** Go's `func f(ctx context.Context, …)`
convention, made implicit — but implicit *only where the compiler owns the
signature*, because a hidden parameter changes the CLR signature and therefore
cannot silently cross an interop boundary:

| Position | Mechanism |
| --- | --- |
| any suspending function whose signature D4 already reshapes — private, local, lambda, non-virtual public, `suspend func` | **hidden leading parameter**. Free, no lookup, no capture. |
| public API a G# author wants context-aware | **explicit** `ctx Context` parameter. Ordinary, visible, callable from C#. |
| public API without an explicit `Context`, called from G# with an ambient context | compiler emits a **private implementation method** taking the hidden parameter plus a **public bridge** that supplies `Context.None`. G# callers bind the private one; C# and reflection callers get the bridge. |
| a suspending lambda converted to a BCL delegate type (`Func[Task]`, etc.) | context is captured **at conversion**, into the closure. Documented: the delegate carries the context of the scope that created it, not of the scope that invokes it. |
| reflection / dynamic invocation | reaches the bridge; context is `Context.None`. |

This costs a synthesized bridge per public suspending function without an
explicit `Context`. That is the price of not lying about the ABI. `AsyncLocal`
was rejected for the hot path, but Phase 3 must **measure** it rather than
dismiss it: if a bridge-heavy public API surface proves worse than an
`AsyncLocal` lookup, the fallback is available and changes nothing else.

Pattern 3 (cancellable pipeline) reduces to an ordinary `for … in ch` loop:
cancellation of the enclosing scope unblocks every stage automatically.

### D8 — `select` is rebuilt around a single registered waiter

Today: probe all receive arms in source order, then all send arms, then
allocate a `Task[]`, convert each `ValueTask<bool>` with `.AsTask()`, block on
`Task.WhenAny`, discard the winner's identity, and re-probe everything
(`MethodBodyEmitter.Statements.cs:656-865`).

New algorithm, which is Go's — and, critically, **transactional**. A channel
becoming *readable* does not reserve its item: another receiver can take it
before the selected body runs, and writability can vanish the same way.
Returning a winning arm index is only sound if winning *is* the transfer.

1. Evaluate channel operands and send values once, left to right.
2. **Fast path.** Visit arms in a **uniform-random order** (Go's fairness;
   today's receive-biased source order is a semantic divergence programs can
   come to depend on) and attempt each with `TryReceive`/`TrySend`. These
   commit atomically or fail; there is no readiness/commit gap.
3. If none succeeds and a `default` arm exists, take it.
4. **Slow path.** Register **one** shared `SelectWaiter` in the waiter queue
   of every arm's channel, then suspend. The waiter is an
   `IValueTaskSource<int>` with:
   - a **CAS-claimed winner slot** — the first channel to reach the waiter
     transitions it from `Pending` to `Claimed`, and *simultaneously deposits
     the transferred value* (for a receive) or *takes the deposited value*
     (for a send). Claiming and transferring are one step, so the winner never
     has to re-probe and can never find the item gone.
   - a **generation counter** bumped on every reuse, checked on every claim.
     Pooled waiters are otherwise open to ABA: a stale registration from a
     completed select can be claimed by a slow channel and consume an item
     nobody is waiting for.
5. **Losers are deregistered** by the resuming waiter before the arm body
   runs. Registrations left behind leak, and worse, can be claimed later.
   Deregistration is O(arms), not O(waiters), via a per-registration node
   handle.
6. **Lock ordering.** Registration touches multiple channels, so it acquires
   their locks in a **global total order** — ascending
   `RuntimeHelpers.GetHashCode`, with an object-identity tiebreak — to make
   `select`-on-overlapping-sets deadlock-free. A `select` naming the same
   channel in two arms locks it once.

**Rendezvous sends need the same discipline.** A selected send must pair with
a receiver only after that arm has irreversibly won; a bare CAS on a winner
slot is not enough, because the receiver must not observe a value the select
then abandons. The rendezvous hand-off is therefore performed *by the
claiming step itself* (step 4), not by the resumed arm body.

**Foreign channels cannot participate.** A foreign `ChannelReader<T>` has no
waiter queue G# can register in, so an arm over one takes a
`WaitToReadAsync`/`WaitToWriteAsync` + re-probe fallback — which reintroduces
the readiness/commit gap and therefore is **not** fully atomic: a foreign arm
may wake, find the item taken, and loop. This is a real semantic difference
from a `Chan[T]` arm, it is unavoidable through a public abstraction that
exposes no reservation primitive, and it is documented rather than papered
over. A `select` mixing both kinds runs the fast path uniformly and the slow
path as "registered waiter on `Chan[T]` arms, polling on foreign arms".

**Faults and cancellation.** A faulted foreign arm propagates its exception
out of `select`. `Task` arms have their continuations unregistered on loss,
so a long-running losing task does not retain the waiter.

New arm kinds:

```gsharp
select {
case let v = <-results {
    return v
}
case <-after(TimeSpan.FromMilliseconds(100)) {
    throw TimeoutError("timed out")
}
case let v = <-fallback when fallback != nil {
    return v
}
case cancelled {
    return nil
}
default {
    return nil
}
}
```

- `case <-after(d)` — a timer-backed selectable, not a real channel and not a
  helper goroutine. This retires the hand-rolled timeout channel in
  `samples/PortScan.gs:52-66` and makes pattern 8 a three-line program.
- `case … when cond` — arm guards. G#-idiomatic (Swift/Kotlin lineage) and a
  readable replacement for Go's nil-channel-disables-the-arm trick, which is
  also supported for Go parity (D1).
- `case cancelled` — explicit handling of the ambient context. **A `select`
  containing this arm suppresses D7's automatic unwind for that operation**,
  otherwise the arm would be unreachable: the cancellation would throw out of
  the `select` before any arm could observe it. This is stated because the two
  decisions are otherwise contradictory. The arm participates in the ordinary
  random ready-arm order and has no priority over a ready channel arm — a
  `select` whose channel is ready *and* whose context is cancelled may take
  either, exactly as Go's `select` may.
- `case let v = await task` — a `Task`/`Task[T]` arm, so `select` can race
  channel work against ordinary BCL asynchrony without a bridging goroutine.

### D9 — A small Go-shaped library, and an explicit list of what is *not* added

Added to `Gsharp.Extensions.Go` (G#-authored where it can be, per ADR-0084):

| Addition | Purpose |
| --- | --- |
| `after(d TimeSpan)` | `time.After` — selectable timer; `d` is the CLR `TimeSpan`, not a Go `Duration` |
| `tick(d TimeSpan)` | `time.Tick` — selectable repeating timer; disposable, see leak note |
| `Context` | `context.Context` bridge: wraps a `CancellationToken`, exposes `Token` for BCL interop, `WithTimeout`, `WithCancel`; the type of `scope`'s implicit `ctx` |
| `merge(inputs …in chan T) in chan T` | fan-in (pattern 4), correct once D3 lands |

Deliberately **not** added, each because the language already answers it
better — the same posture ADR-0158 took:

| Go primitive | G# answer |
| --- | --- |
| `sync.WaitGroup` | `scope` (D6) |
| `errgroup.Group` | `scope` (D6) |
| `context.WithCancel` | `scope`'s implicit `ctx` (D6/D7) |
| `sync.Once` | `Lazy[T]` |
| `sync.Mutex` | `lock` (#1885) |
| `sync.RWMutex` | `ReaderWriterLockSlim` |
| `sync.Map` | `SyncMap[K, V]` (ADR-0158) |
| `atomic.*` | `Interlocked` (ADR-0039) |

### D10 — Batch channel operations: the data-processing lever

`Chan[T]` exposes bulk transfer, and the language exposes a chunked iteration
form. The API is split by whether it can park, because that determines what
kind of buffer it can accept:

```gsharp
// non-suspending: Span is legal, never crosses a suspension point
func (ch in chan T) TryReceiveBatch(buffer Span[T]) int32
func (ch out chan T) TrySendBatch(items ReadOnlySpan[T]) int32

// suspending: Memory only
suspend func (ch in chan T) ReceiveBatch(buffer Memory[T], atLeast int32) int32
suspend func (ch out chan T) SendBatch(items ReadOnlyMemory[T]) int32
```

An earlier draft used `Span[T]` for the suspending forms. That is not
implementable: a receive that parks must retain its destination across the
suspension, and `Span<T>`/`ReadOnlySpan<T>` are ref-like — they cannot be
hoisted into a heap-allocated state machine, and the channel cannot retain
one. `Memory<T>` is the correct currency for anything that can park; `Span<T>`
survives only on the paths that provably cannot.

**Completion semantics**, which a batch API cannot leave undefined:

| Condition | `ReceiveBatch` returns |
| --- | --- |
| `atLeast` elements available | ≥ `atLeast`, up to `buffer.Length`, without parking again |
| fewer available, channel open | parks until `atLeast` are transferred |
| channel closed mid-batch | the count transferred so far, possibly 0; the *next* call reports closed |
| context cancelled mid-batch | the count transferred so far (D7's linearization rule) — **never** a bare throw that hides the count |

`atLeast = 1` is Go's `range`-like behavior — take what is there, do not wait
to fill. `atLeast = buffer.Length` is a full-fill barrier. The parameter
exists because both are legitimate and the default is genuinely ambiguous.

**Rendezvous channels do not batch.** `cap(ch) == 0` means one value in
flight by definition, so `ReceiveBatch` on a rendezvous channel degenerates to
`atLeast` sequential rendezvous transfers. That is correct but pointless;
GS0562 warns.

```gsharp
for batch in chunks(input, 1024) {
    process(batch)                 // batch is a ReadOnlyMemory[T]
}
```

One lock acquisition and one park amortized across the whole batch. Measured
on the CLR side: **54.4 ns/op → 6.8 ns/op at 64 items/chunk → 2.9 ns/op at
1024 items/chunk**.

This is deliberately *not* claimed as a win over Go — Go can chunk too, and
measured faster (3.6 and 0.7 ns/op). It is claimed as the shape a G# data
pipeline should be written in, and as the point where the surviving gap stops
being about channels and starts being about codegen, where the CLR's
`Vector[T]` and hardware intrinsics are available to a G# stage and have no
portable Go equivalent.

The slogan is **"share *buffers* by communicating"** — owned memory, handed
over. Not "share spans": a borrowed stack view is exactly the thing that
cannot be communicated across a suspension, and naming it that way would
encourage the one mistake this section exists to prevent.

### D11 — A comparative performance program, with budgets, in CI

Claims about Go parity are worthless without a harness that can refute them.
This ADR ships one:

- `bench/concurrency/` containing **paired G# and Go programs** for each
  scenario in the baseline table, plus a runner producing JSON, following the
  precedent of `build/generate-quality-dashboard.py:76-180` and feeding the
  same `website/static/data/quality-dashboard.json`.
- **Mandatory warm-up.** The spike measured cold CLR numbers 2–3× worse than
  warm ones; any comparison without warm-up rounds is invalid and the runner
  must enforce them.
- **Methodology requirements**, without which the ratios are noise: pinned
  toolchain versions (both runtimes), a declared hardware class, **multiple
  process launches** rather than in-process repetition alone, and reported
  confidence intervals. Two gates, kept separate:
  - a **hard gate** on within-runtime regression (G# vs its own last recorded
    number), which is stable and belongs in the PR gate;
  - an **informational** G#-vs-Go ratio, which depends on the Go toolchain and
    the machine and must not fail a PR.
- **Per-scenario budgets** — the operational form of "as good as or better
  than Go". These are **provisional targets, not validated results**. Every
  one of them was derived from a spike that predates the semantics this ADR
  specifies, and three are already known to be wrong in the ways noted:

| Scenario | Target vs Go | Status of the evidence |
| --- | --- | --- |
| Receive from closed channel | ≤ 1.0× | **supported** — 1949 → 4.4 ns/op vs Go's 5.1 is pure defect removal |
| Goroutine spawn | ≤ 1.2× | **partial** — 220 vs 202 ns covers queueing only; D4/D5/D6 add capture, state machine, sink, and registration. Re-derive in Phase 3. |
| Parked-goroutine memory, depth 1 | ≤ 0.5× | **supported at depth 1 only** — measure depths 1/4/16; the target applies per depth, and D4's per-frame cost may fail it at depth |
| Buffered throughput, per message | ≤ 1.8× | **not yet met by any measured implementation** — best CLR is 44.9/25.5 = 1.76×, so the earlier ≤1.5× target was already refuted by the ADR's own data. 1.8× holds the measured line; tightening requires a result that does not exist yet. |
| `select`, ready arms | ≤ 1.2× | **not evidence-backed** — the 30.7 vs 53.3 ns result compared deterministic source-order probing against Go's randomized choice, i.e. it partly measured the divergence D8 removes. Re-derive after D8. |
| `select`, parking path | **to be established** | never measured. Phase 4 establishes the baseline before setting a target. |
| Rendezvous round trip | **to be established** | never measured — wave 1 has no rendezvous channel; the 1158 ns figure is a capacity-1 channel. Phase 1 must build the real baseline. |
| Chunked throughput | ≤ 2.0× | plausible; GC write barriers and array bounds are structural |
| Goroutines schedulable while N are parked | unbounded | **supported** — today fails at 400 |

The discipline this table encodes matters more than the numbers in it: a
budget is set **after** the semantics-equivalent implementation is measured,
and a budget that proves unreachable is **revised with its measurement
recorded**, never quietly dropped. Rendezvous is the likeliest candidate.
The spike's hand-written `hchan` measured *worse* than the BCL channel
(105.8 ns/op), which is evidence that the queue is not the bottleneck —
park/unpark and scheduler hand-off are — but it was a *buffered* benchmark
and therefore does not settle the rendezvous question either.

## Consequences

### Breaking changes

| # | Change | Migration |
| --- | --- | --- |
| 1 | `make(chan T)` becomes a rendezvous channel; it was unbounded | GS0548 (warning, one release; then behavior change): "`make(chan T)` is unbuffered — specify a capacity or accept rendezvous semantics." Mechanical fix: `make(chan T, n)`. |
| 2 | Receiving from a closed channel no longer raises and swallows `ChannelClosedException` | Observable only as a large speed-up, and through profilers/first-chance-exception handlers. |
| 3 | `make(chan T, …)` constructs `Chan[T]`, not `Channel.CreateUnbounded`'s channel | **No source break.** `chan T` still *is* `Channel[T]`, so inbound and outbound interop are both unchanged. Observable only if code depended on the concrete runtime type. |
| 4 | A function performing a channel operation becomes suspending, and its emitted CLR signature changes to return `ValueTask[R]` | Within an assembly, invisible. Across an assembly boundary it is binary-breaking — the same class of change as altering a return type. GS0560 warns where it happens; the strict-API opt-in escalates it to an error for libraries with a published surface. |
| 5 | A suspending function may no longer convert to a non-suspending delegate type | GS0553 with the fix in the message. Affects code passing channel-touching lambdas to sync BCL callbacks (`Comparison[T]`, `Action`). |
| 6 | `select` chooses uniformly at random among ready arms | Programs depending on today's receive-biased source order break. That dependency was never specified, and `samples/PortScan.gs:57` documents relying on it — the sample must be rewritten as part of this work. |
| 7 | Channel operations are cancellation points | A blocked operation in a cancelled scope now throws instead of hanging. This is the intended behavior of ADR-0022 §scope. D7's linearization rule bounds it: a committed transfer still succeeds. |
| 8 | `ExecutionContext` no longer flows into a goroutine (D5) | `AsyncLocal[T]`, `Activity`/distributed tracing, `CultureInfo`, and `ClaimsPrincipal` stop propagating across `go`. Hosts that need continuity must capture explicitly. Phase 3 measures the cost of restoring a minimal capture before this is locked in. |

### What this unlocks

- The four "awkward workaround" patterns become idiomatic; the two
  "expressible with caveats" channel patterns (1 and 8) become clean. The
  pattern-study table is the acceptance criterion.
- The `chan T?`-with-`nil`-sentinel protocol disappears from the corpus and
  from the documentation.
- `scope` becomes a genuinely better primitive than Go's `WaitGroup` +
  `errgroup` + `context` triple, which is the strongest "distinctly G#"
  claim in the surface.
- G# can hold more shallow-parked operations per byte than Go. The advantage
  is depth-dependent (D4) and is measured per depth, not assumed.

### Operational and tooling consequences

These are user-visible, and each needs a gate in the execution plan rather
than a discovery in the field.

| Area | Consequence | Required response |
| --- | --- | --- |
| **Debugging and stack traces** | D4 turns ordinary-looking functions into state machines. Call stacks become `MoveNext` frames; exception traces lose the logical G# frame. ADR-0023 notes await sequence-point markers are still emitted as `nop`s pending PDB support, so this lands on an already-weak foundation. | Phase 3 gate: source-level stack traces through inferred state machines, and a debugger step-over that does not descend into `MoveNext`. This is a **blocking** gate — inferred coloring that makes debugging worse is a bad trade regardless of throughput. |
| **Hot reload** | Adding or removing a channel operation changes a method's signature *and* its state-machine shape. Both are rude edits. | `Gsharp.HotReload.Runtime` reports a clear restart-required diagnostic naming suspension change as the cause, rather than failing opaquely. |
| **`gsi` / emitted-only engine (ADR-0156)** | `gsi` executes emitted IL in an in-memory load context and must resolve `Gsharp.Runtime.Channels` there. | Phase 1 gate: a `gsi` smoke test exercising `make`/send/receive/`select`. |
| **`cs2gs`** | C# translated to G# can contain synchronous callbacks that become invalid once inferred suspension propagates into them. | Phase 3: migration corpus test; `cs2gs` emits `suspend func`/`async func` explicitly rather than relying on inference. |
| **Process exit** | Thread-pool threads are background threads. A free goroutine still running when the entry point returns is abandoned mid-flight — wave 1 has the same property via `Task.Run`, but D5 makes goroutines cheap enough that programs will have many more of them. | Documented explicitly; GS0563 warns on unscoped `go`. `scope` is the answer, and the guide leads with it. |
| **Leaks** | An abandoned `tick` timer keeps firing; a goroutine parked forever on a channel nobody closes is unreclaimable. | `tick` returns a disposable; `using let` is the idiomatic form. A debug-mode runtime counter of live goroutines and registered waiters, surfaced by the runtime hook. |
| **Deadlock detection** | Go detects total deadlock ("all goroutines are asleep") because its scheduler owns every runnable entity. G# goroutines share the CLR thread pool with the rest of the process, so the equivalent global check is not available. | **Explicitly out of scope**, stated rather than omitted. Partial mitigation: `scope` can report the count and source locations of children still parked at a configurable timeout, which catches the common case without claiming Go's guarantee. |

### What this costs

- `Gsharp.Runtime.Channels` is a new hot-path assembly to maintain, in C#,
  with the ADR-0154 evidence burden that implies — and the transactional
  select protocol in D8 is genuinely hard concurrent code, the kind that is
  correct only with dedicated stress testing.
- Suspension inference is the largest binder change since async, and it makes
  a function's emitted signature depend on its body. GS0560 exists to keep
  that from being silent.
- Every public suspending function without an explicit `Context` costs a
  synthesized bridge overload (D7).
- Deep suspending call chains cost more than Go's single growable stack, and
  the memory advantage narrows with depth.
- Debugging and hot reload both get worse before tooling catches up; the
  Phase-3 gates exist because "faster but undebuggable" is not a trade this
  project should make silently.
- Programs importing `Gsharp.Extensions.Go` gain a runtime dependency they
  did not have. Programs that do not import it are unaffected (ADR-0082).

### What this forecloses

Nothing about actors (#2485). If actors land, they become the language
answer for *owned mutable state*; channels remain the answer for
*communication*, and the suspension machinery in D4 is exactly the
infrastructure an actor implementation would need.

## Diagnostics

This ADR allocates **GS0548–GS0565**. The highest identifier currently
allocated in the repository's `GS05xx` band is GS0547, verified against
`DiagnosticDescriptors`; conventions are documented at
`docs/diagnostics.md:24-32, 46-83`.

| ID | Severity | Meaning |
| --- | --- | --- |
| GS0548 | Warning → Error | `make(chan T)` is unbuffered; supply a capacity or accept rendezvous semantics |
| GS0549 | Error | Cannot send on a receive-only channel (`in chan T`) |
| GS0550 | Error | Cannot receive from a send-only channel (`out chan T`) |
| GS0551 | Error | Cannot `close` a receive-only channel |
| GS0552 | Error | A suspending override cannot implement a non-suspending declaration |
| GS0553 | Error | A suspending function cannot convert to a non-suspending function type |
| GS0554 | Error | Two-value receive requires exactly two targets |
| GS0555 | Error | `while let` over a channel binds on completion, not nullability (guidance when the operand is not a receive) |
| GS0556 | Error | `select` arm guard must be a boolean expression |
| GS0557 | Error | `case cancelled` is only valid inside a `scope` |
| GS0558 | Warning | Suspending call in a non-suspending root context will block a thread |
| GS0559 | Error | `len`/`cap` require a channel created by `make`; not available on a foreign `Channel[T]`, reader, or writer |
| GS0560 | Warning (Error under strict API) | Public function became suspending by inference; declare `suspend func` to pin the signature contract |
| GS0561 | Error | This member cannot suspend (constructor, accessor, static initializer, operator, finalizer, `Dispose`, or synchronous iterator) |
| GS0562 | Warning | Batch operation on a rendezvous channel degenerates to sequential transfers |
| GS0563 | Warning | Goroutine spawned outside a `scope`; its failure is fail-fast and it is not awaited |
| GS0564 | Error | A `select` arm's channel operand appears in another arm with an incompatible direction |
| GS0565 | Warning | `defer` body performs a channel operation; it will run under a shielded context with a bounded grace budget |

## Execution plan

| Phase | Contents | Gate |
| --- | --- | --- |
| **1 — Runtime** | `Gsharp.Runtime.Channels`, `Chan[T]`, rendezvous, FIFO waiters, two-value receive, `Memory[T]` batch transfer, transactional `SelectWaiter` with generation counters and lock ordering; SDK packaging | C# unit tests + ADR-0154 mutant witnesses; **stress tests for the select protocol** (concurrent claim, ABA on pooled waiters, loser deregistration, close/cancel races); **memory-model tests** for the happens-before claims; `gsi` in-memory load-context smoke test; **true rendezvous baseline measured** and the D11 row filled in |
| **2 — Observable completion** | D1 rebinding, D2 directional types and the foreign-channel matrix, D3's four surfaces, `len`/`cap`, GS0548–GS0551, GS0554–GS0555, GS0559 | Patterns 1, 4, 9 rewritten as samples with `.golden` output; `chan T?` sentinel deleted from docs; foreign-channel matrix covered row by row, including the `WaitToReadAsync` + `TryRead` **loop** under a competing consumer |
| **3 — Suspension** | D4 inference and ABI, `suspend func`, `[Suspending]` metadata, builder selection, D5 `go` lowering and completion sink, #3304, GS0552/GS0553/GS0558/GS0560/GS0561/GS0563 | Starvation spike inverts: 400 parked + 1 spawned schedules immediately; **source-level stack traces and debugger step-over through inferred state machines** (blocking); hot-reload restart diagnostic; `cs2gs` migration corpus; `ExecutionContext` cost measured before isolation is locked in; spawn budget re-derived end-to-end |
| **4 — Structure and selection** | D6 `scope` and its precedence table, D7 cancellation with the linearization rule and `defer` shielding, D8 `select`, D9 library, GS0556/GS0557/GS0564/GS0565 | Patterns 3, 7, 8 rewritten as samples; `PortScan.gs:57` rewritten off source-order dependence; **cancel-vs-commit race tests** proving no value is lost or duplicated; `defer`-under-cancellation tests including a `defer` that itself uses a channel |
| **5 — Performance** | D10 batch surface, D11 harness, budget ratchet in CI | Budgets **set** from semantics-equivalent measurements, then ratcheted; within-runtime regression gate in the PR gate, Go ratio informational only |

Phases 1–2 are independently shippable and already retire the four
"awkward workaround" ratings. Phase 3 is the risk concentration, on two
independent axes: if *inference* proves unworkable, the fallback is to extend
the declaration requirement inward until every suspending function is written
`suspend func` — this costs the Go shape but keeps every other decision
intact. If *debuggability* through inferred state machines cannot be made
acceptable, that is a stop-and-reconsider for D4 specifically, not for the
ADR: D1–D3 and D6–D11 stand on their own, and the surface would ship with
blocking semantics and a documented goroutine ceiling until the platform
offers something better.

## Evidence — feasibility spike

Paired harness, .NET 10.0.11 / Go 1.27.0, 18 cores, three CLR warm-up
rounds. Reproduces the emitter's exact call sequences for the "G# today"
rows.

1. **A `Channel<T>` subclass is interop-transparent.** A derived channel with
   custom `ChannelReader`/`ChannelWriter` compiles, flows as `Channel<T>`,
   and is consumed by `ReadAllAsync()` / `await foreach` unmodified; the
   added `TryReceive(out value, out ok)` returns `ok=false` on a closed
   channel **with no exception**. D1 and D3 are mechanically sound. Note the
   limit of what this proves: it establishes *assignability* of `Chan[T]` to
   `Channel[T]`, which is why D1 binds the **type** `chan T` to `Channel[T]`
   and only the **constructor** to `Chan[T]`.
2. **An incomplete `IValueTaskSource`-backed `ValueTask` cannot be
   synchronously consumed.** Removing `.AsTask()` from the current lowering
   throws `InvalidOperationException: The asynchronous operation has not
   completed`. Scoped precisely: this is Channels' `IValueTaskSource`
   implementation, not a property of `ValueTask` in general. There is no
   incremental fix for the lowering; D4 is required.
3. **Thread-pool starvation is real and total.** 400 goroutines blocked on an
   empty channel; a 401st spawned afterwards **never ran within 60 seconds**
   (375 OS threads). The async counterpart parks 200 000 receivers in 400 ms
   at 384 bytes each — at suspension depth 1.
4. **The queue is not the bottleneck, for buffered transfer.** A hand-written
   Go-style `hchan` with ring buffer, FIFO waiter queues, and pooled
   `IValueTaskSource` waiters measured 105.8 ns/op — *worse* than
   `System.Threading.Channels`' 44.9. The gap to Go is park/unpark and
   scheduler hand-off. This is why D4, not a queue rewrite, is the
   load-bearing decision. It does **not** settle the rendezvous case, which
   this benchmark never exercised.
5. **`PoolingAsyncValueTaskMethodBuilder` eliminates steady-state
   state-machine allocation.** 10 000 suspending invocations that each park on
   a channel and resume measured **~0 bytes per invocation** of net
   allocation, versus a state-machine box per invocation with the default
   builder. This is what makes D4's "a saturated pipeline allocates nothing"
   claim concrete. Qualifier: pooling is bounded, and overflow falls back to
   ordinary allocation.
6. **Confirmed defect magnitudes.** Closed-receive 1949 → 4.4 ns/op; spawn
   358 → 220 ns/op queueing cost (Go: 202); parked memory 384 B at depth 1
   (Go: 2669 B). The `select` and rendezvous figures in the baseline table are
   **not** carried into the budgets, for the reasons stated there.

Harness sources live in `bench/concurrency/` (outside `GSharp.sln`, so they
never enter a product build); Phase 1 adopts them as the D11 suite.

**These absolute figures are one run, and they move.** A later run on the same
machine under different load measured the buffered-transfer row at 74.1 ns/op
rather than 54.4, and parked-receiver cost at 217 B rather than 384. The
*ratios* and the qualitative findings reproduce — starvation still never
schedules the extra goroutine inside 60 s, closed-receive is still ~400×
— but no single number here is a threshold. This is exactly why D11's budgets
are stated as ratios against a same-run baseline, and why
`bench/concurrency/README.md` requires multiple process launches before any
number is believed.

**Discrimination witnesses (ADR-0154).** Every guarantee in this ADR must be
provably killed by the mutation it polices, or it is not being tested. The
performance budgets:

- restoring the `ChannelClosedException` handler fails the closed-receive
  budget by ~400×;
- reverting D5 to `Task.Run` fails the spawn budget and shows the `Task`
  allocation;
- reverting D4 to blocking receives fails the schedulability gate outright
  (it never completes);
- reverting D8 to the `WhenAny` re-probe loop fails the select budget and
  shows the per-iteration `Task[]` in allocation counts;
- removing `PoolingAsyncValueTaskMethodBuilder` shows a state-machine box per
  invocation in allocation counts.

The correctness guarantees, which matter more and are easier to leave
untested:

- **rendezvous** — a mutant that lets `make(chan T)` buffer one element must
  fail a test asserting the sender does not proceed until a receiver arrives;
- **select atomicity** — a mutant that splits claim-and-transfer into
  "claim, then re-probe" must fail a stress test under a competing consumer
  by delivering an item twice or losing one;
- **waiter generation counter** — a mutant that omits the bump must fail an
  ABA stress test in which a pooled waiter is reused between registration and
  claim;
- **loser deregistration** — a mutant that skips it must fail a leak test
  counting registered waiters after N completed selects;
- **lock ordering** — a mutant that locks in arm order must deadlock a test
  running two selects over the same two channels in opposite order;
- **cancellation linearization** — a mutant that lets cancellation win after
  commit must fail a test asserting no value is lost when a cancel races a
  completed transfer;
- **`defer` shielding** — a mutant that runs `defer` under the cancelled
  context must fail a test whose cleanup performs a channel operation;
- **`while let` nullable elements** — a mutant applying ADR-0163's nullable
  stripping must fail a test that sends a legitimate `nil` on a `chan T?` and
  asserts the body ran;
- **happens-before** — a mutant that publishes the payload after the transfer
  commits must fail a test reading a field written before the send.

## Alternatives considered

### Add two-value receive and stop there

The cheapest change, and it does retire the `nil`-sentinel protocol. Rejected
as insufficient: it leaves `make(chan T)` silently unbounded, leaves
`select` receive-biased, leaves `scope` without prompt cancellation, and
leaves the starvation defect — a program that finally *can* express a
correct pipeline still deadlocks at 400 goroutines. Fixing expressability
while leaving the runtime broken produces confident, wrong programs.

### Explicit coloring: require `suspend func` on all channel-touching code

Mechanically the simplest route to D4's benefits — the async state-machine
emitter already exists (ADR-0023). Rejected as the *primary* design because
it breaks the promise this whole surface exists to keep: a Go programmer's
`func worker(jobs in chan Job)` would have to be spelled `suspend func`, and
every caller up the chain with it. That is C#'s ergonomics wearing Go's
syntax.

**Partially adopted, deliberately.** D4 requires explicit declaration at
exactly the places where inference is *unsound* — virtual and interface
declarations, and function-typed parameters and returns — and warns (GS0560)
where it is merely a versioning hazard. The design is therefore "inferred
wherever it is sound, declared where dispatch or representation makes it
impossible". If Phase 3's inference proves unworkable, the fallback is to
extend the declaration requirement inward; every other decision in this ADR
survives intact.

### Green threads / continuations on the CLR

The one design that would give Go's model exactly. Rejected as unavailable:
the runtime-lab experiment was concluded without shipping, and there is no
continuation-capture primitive to build on. Nothing in this ADR forecloses
adopting one if the platform ever ships it — D4's inference would become the
mechanism for deciding which functions get green stacks.

### One OS thread per goroutine

Rejected by measurement: 400 blocked receivers already produced 375 OS
threads and a scheduling failure. This does not scale to Go's goroutine
counts by two orders of magnitude.

### Bind `chan T` to the concrete `Chan[T]`

This ADR's own earlier draft. It reads well — "`chan T` **is** a G# channel" —
and it makes every operation a direct call with no type test. Rejected on
review: binding the type to the subclass means a foreign `Channel[T]` from C#
or NuGet is no longer assignable to `chan T`, which narrows inbound interop
for no benefit that the constructor-only binding does not already provide.
Subtype assignability is not the same property as ADR-0158's identity
transparency, and claiming it was would have been the ADR asserting
compliance it did not have. The type test on the fast path is a predictable
branch.

### Keep `Channel<T>` exactly, add helpers around it

Rejected: `Channel<T>` cannot express rendezvous (bounded-1 lets the sender
complete before a receiver arrives, which is not Go's synchronization
guarantee — see D1's memory model), has no multi-channel select registration
primitive, cannot report `ok` without an exception, and cannot grow any of
them through a sealed public abstraction. D1 takes the narrowest form of this
that works: the *type* stays `Channel[T]`, so nothing about interop changes;
only what `make` constructs is new.

### Rewrite the channel queue for speed

Rejected by the spike's own result: the hand-written `hchan` was slower than
the BCL's. Recorded here specifically so the idea is not re-proposed on
intuition.

### Actors instead (#2485)

Still the right long-term direction for *owned mutable state*, still not the
answer to "my pipeline stage cannot tell a closed channel from a zero", and
still a multi-ADR effort. ADR-0158 declined to prejudge it; so does this one.
D4's suspension machinery is a prerequisite for any actor design on the CLR,
so this work moves that horizon closer rather than further.

## Open questions

1. ~~**Spelling of directional types.**~~ **Resolved**: `in chan T` /
   `out chan T`, not Go's `<-chan T` / `chan<- T`. Rationale and the Go
   translation table are in D2.
2. ~~**Is `suspend func` the right boundary spelling?**~~ **Resolved**: yes, a
   distinct keyword. `async func`'s task is *observable* and `suspend func`'s
   is not; conflating them is the mistake an earlier draft of D4 made, and
   reusing `async func` with an "unobserved task" convention would reintroduce
   it as an unwritten rule. The third keyword is worth its cost.
3. **Does `[Suspending]` belong in the public metadata contract?** Metadata is
   chosen for cost and clarity, but with D4's boundary rule the attribute is
   now largely *descriptive* — the CLR signature already says `ValueTask[R]`.
   It may be reducible to a documentation aid rather than a load-bearing
   contract.
4. **Hidden context parameter vs `AsyncLocal`.** D7 chooses the hidden
   parameter and requires Phase 3 to measure the alternative. If the
   synthesized public bridges prove to be a significant surface-area tax, the
   trade may go the other way. This is the decision most likely to be revised
   by data.
5. **Should `default` remain a `select` arm now that `TryReceive` exists?**
   Go parity says yes; minimalism says the non-blocking form could be a
   method. Keeping it.
6. **Batch iteration syntax.** `for batch in chunks(ch, 1024)` is a library
   call; a first-class `for batch of 1024 in ch` form is more discoverable
   and more optimizable. Deferred to Phase 5, where D11's numbers can settle
   it.
7. **Rendezvous target.** No rendezvous baseline exists yet (wave 1 has no
   rendezvous channel). Phase 1 must produce one before a budget can be set.
   If the achievable ratio is poor, is that acceptable, or does it justify a
   documented recommendation to prefer buffered channels in G#? Decide with
   data, in Phase 5.
8. **Free-goroutine failure policy.** D5 chooses fail-fast, matching Go's
   unrecovered panic. An alternative is to log and continue, which is friendlier
   to server hosts but hides bugs. The runtime hook makes either possible; the
   default is the question.

## Addendum A — The ten patterns, three ways

The pattern study in the Context section gives ratings. This addendum gives
the code, so the ratings can be checked rather than trusted. Each pattern
appears as Go, as **G# 0.4** (what the corpus is forced to write today), and
as **G# vNext** (what it becomes if every decision here lands).

Two conventions used throughout:

- **G# 0.4 examples are transcribed from the August 2026 study**, not
  idealized. Where they look laborious, that is the finding.
- **vNext examples use plain `func`.** Top-level declarations are `public` by
  default (ADR-0006), so D4's GS0560 would suggest pinning these with
  `suspend func`. Application code can ignore that; a published library
  should not, and pattern 9 shows the declared form for contrast.

Seven of the ten patterns change. **Three do not** — 5, 6, and 10 are lock and
atomic patterns that ADR-0158 and CLR interop already answer well, and this
ADR deliberately does not touch them. That is the scope boundary, shown rather
than asserted.

---

### Pattern 1 — Worker pool

**Go**

```go
func WorkerPool(jobs <-chan int, workers int, work func(int) int) <-chan int {
    results := make(chan int)
    var wg sync.WaitGroup
    wg.Add(workers)

    for i := 0; i < workers; i++ {
        go func() {
            defer wg.Done()
            for v := range jobs {
                results <- work(v)
            }
        }()
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    return results
}
```

**G# 0.4** — every stream protocol is rewritten to `chan T?` with `nil`
reserved as an end-of-stream sentinel, because a closed receive is
indistinguishable from a legitimate zero.

```gsharp
import Gsharp.Extensions.Go

func worker(jobs chan Job?, results chan Result?) {
    for {
        let job = <-jobs
        if job == nil {
            return
        }
        results <- process(job!!)
    }
}

let results = make(chan Result?, resultCapacity)

go func() {
    scope {
        for i in 0 ... workerCount {
            go worker(jobs, results)
        }
    }
    close(results)
}()
```

**G# vNext**

```gsharp
import Gsharp.Extensions.Go

func worker(jobs in chan Job, results out chan Result) {
    for job in jobs {
        results <- process(job)
    }
}

func run(jobs in chan Job, workers int32) in chan Result {
    let results = make(chan Result)
    go func() {
        scope {
            for i in 0 ... workers {
                go worker(jobs, results)
            }
        }
        close(results)
    }()
    return results
}
```

> **Delta.** `for job in jobs` (D3c) removes the sentinel protocol and the
> `!!` unwraps; `Job` no longer has to be nullable. Directional types (D2)
> make "workers may not close `results`" a compile error rather than a
> comment. `scope` (D6) still replaces the `WaitGroup` — that part was
> already better than Go.

---

### Pattern 2 — Bounded concurrency

**Go**

```go
func ForEachLimit(items []int, limit int, f func(item int)) {
    sem := make(chan struct{}, limit)
    var wg sync.WaitGroup

    for _, item := range items {
        sem <- struct{}{}
        wg.Add(1)
        go func(item int) {
            defer wg.Done()
            defer func() { <-sem }()
            f(item)
        }(item)
    }

    wg.Wait()
}
```

**G# 0.4** — already good. The permit release needs a named helper because
`defer` takes a call.

```gsharp
import Gsharp.Extensions.Go

func release(sem chan bool) {
    let permit = <-sem
}

func runOne(item Item, sem chan bool) {
    defer release(sem)
    process(item)
}

let sem = make(chan bool, limit)

scope {
    for item in items {
        sem <- true
        go runOne(item, sem)
    }
}
```

**G# vNext** — essentially unchanged, and that is the point: this pattern was
already the surface's best fit.

```gsharp
import Gsharp.Extensions.Go

func runOne(item Item, sem chan bool) {
    defer release(sem)
    process(item)
}

let sem = make(chan bool, limit)

scope {
    for item in items {
        sem <- true            // blocks at `limit`; now also cancellable (D7)
        go runOne(item, sem)
    }
}
```

> **Delta.** Two behavioral fixes, no syntax change. The blocking `sem <- true`
> no longer pins an OS thread (D4), so the spawner cannot starve the pool it
> is feeding; and it now unwinds on scope cancellation instead of hanging
> (D7). `make(chan bool, limit)` was already correct — `limit` is positive, so
> defect 3 never bit here.

---

### Pattern 3 — Cancellable pipeline

**Go**

```go
func Stage(ctx context.Context, in <-chan int, f func(int) int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            select {
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case out <- f(v):
                case <-ctx.Done():
                    return
                }
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}
```

**G# 0.4** — the `done`-channel pattern Go abandoned a decade ago, plus a
`nil` sentinel, plus nested `select` on both the receive *and* the send.

```gsharp
func transform(input chan Item?, output chan Item?, done chan bool) {
    defer close(output)

    for {
        select {
        case <-done {
            return
        }
        case let item = <-input {
            if item == nil {
                return
            }

            let next = mapItem(item!!)
            select {
            case <-done {
                return
            }
            case output <- next {
            }
            }
        }
        }
    }
}
```

**G# vNext**

```gsharp
func stage[T, R any](input in chan T, f (T) -> R) in chan R {
    let out = make(chan R)
    go func() {
        defer close(out)
        for v in input {
            out <- f(v)
        }
    }()
    return out
}
```

> **Delta.** The single largest reduction in the study. Both `select`s vanish:
> D7 makes every channel operation a cancellation point, so cancellation
> unwinds through `for..in` and the send without being written down, and
> `defer close(out)` still runs. The `done` channel, the sentinel, the nesting,
> and the explicit `ctx` plumbing all disappear — and unlike Go, forgetting a
> cancellation check is no longer possible, because there is nothing to
> forget.

---

### Pattern 4 — Fan-in merge

**Go**

```go
func Merge(inputs ...<-chan int) <-chan int {
    out := make(chan int)
    var wg sync.WaitGroup
    wg.Add(len(inputs))

    for _, ch := range inputs {
        go func(ch <-chan int) {
            defer wg.Done()
            for v := range ch {
                out <- v
            }
        }(ch)
    }

    go func() {
        wg.Wait()
        close(out)
    }()

    return out
}
```

**G# 0.4** — the topology works; the termination protocol does not. A
forwarder over a non-nullable channel would spin forever on zero values.

```gsharp
func forward(input chan Item?, output chan Item?) {
    for {
        let value = <-input
        if value == nil {
            return
        }
        output <- value
    }
}

func merge(inputs []chan Item?) chan Item? {
    let output = make(chan Item?)

    go func() {
        scope {
            for input in inputs {
                go forward(input, output)
            }
        }
        close(output)
    }()

    return output
}
```

**G# vNext** — and since this is now a three-line body, D9 ships it as
`merge` so nobody writes it again.

```gsharp
func merge[T any](inputs ...in chan T) in chan T {
    let out = make(chan T)
    go func() {
        scope {
            for input in inputs {
                go func() {
                    for v in input {
                        out <- v
                    }
                }()
            }
        }
        close(out)
    }()
    return out
}

// or just:
let combined = merge(a, b, c)
```

> **Delta.** `for v in input` (D3c) supplies the termination the workaround
> could not express at any element type. The forwarder no longer needs to be
> a named function, because the goroutine literal can capture `input`
> per-iteration.

---

### Pattern 5 — TTL cache with reader/writer locking

**Go**

```go
func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    e, ok := c.data[key]
    if !ok || !c.now().Before(e.expiresAt) {
        return "", false
    }
    return e.value, true
}
```

**G# 0.4**

```gsharp
import System
import System.Collections.Generic
import System.Threading

class Cache {
    private let gate = ReaderWriterLockSlim()
    private let entries = Dictionary[string, Entry]()
    private let now () -> DateTimeOffset

    init(clock () -> DateTimeOffset) {
        now = clock
    }

    func Get(key string) Entry? {
        gate.EnterUpgradeableReadLock()
        defer gate.ExitUpgradeableReadLock()

        var entry Entry
        if !entries.TryGetValue(key, out entry) {
            return nil
        }
        if now() < entry.ExpiresAt {
            return entry
        }

        gate.EnterWriteLock()
        defer gate.ExitWriteLock()
        entries.Remove(key)
        return nil
    }
}
```

**G# vNext — unchanged.**

> **Delta: none, deliberately.** This is shared-memory synchronization, the
> exact thing "share memory by communicating" is the alternative to. ADR-0158
> already decided G#'s answer here (`lock`, `SyncMap[K,V]`, and CLR interop for
> `ReaderWriterLockSlim`), and D9 explicitly declines to add `sync.RWMutex`.
> Nothing in this ADR should change this code, and if a future draft makes it
> shorter, that is scope creep.

---

### Pattern 6 — Keyed token-bucket limiter

**Go**

```go
func (l *KeyedLimiter) Allow(key string) bool {
    l.mu.Lock()
    defer l.mu.Unlock()
    // ... one mutex for every key
}
```

**G# 0.4** — already *better* than the Go reference: a concurrent dictionary
with a per-key lock, instead of one global mutex.

```gsharp
let bucket = buckets.GetOrAdd(key, (_ string) -> Bucket(burst))

lock bucket {
    let now = DateTimeOffset.UtcNow
    let elapsed = (now - bucket!!.LastRefill).TotalSeconds

    if elapsed > 0.0 {
        bucket!!.Tokens = Math.Min(burst, bucket!!.Tokens + elapsed * ratePerSecond)
        bucket!!.LastRefill = now
    }
}

if bucket!!.Tokens < 1.0 {
    return false
}

bucket!!.Tokens -= 1.0
return true
```

**G# vNext — unchanged.**

> **Delta: none.** Same reasoning as pattern 5. Worth stating because a
> concurrency ADR that touched every pattern would be overreaching: this one
> was already idiomatic and already outperformed its Go reference.

---

### Pattern 7 — Structured-concurrency `All`

**Go**

```go
func All(ctx context.Context, fns ...func(context.Context) error) error {
    gctx, cancel := context.WithCancel(ctx)
    defer cancel()

    var (
        once  sync.Once
        first error
        wg    sync.WaitGroup
    )

    wg.Add(len(fns))
    for _, fn := range fns {
        go func(fn func(context.Context) error) {
            defer wg.Done()
            if err := fn(gctx); err != nil {
                once.Do(func() {
                    first = err
                    cancel()
                })
            }
        }(fn)
    }

    wg.Wait()
    return first
}
```

**G# 0.4** — every child hand-rolls first-error installation and sibling
cancellation, because `scope` cancels only *after* `Task.WhenAll` has already
waited for everyone.

```gsharp
async func child(
    work (CancellationToken) -> Task,
    cts CancellationTokenSource,
    first FirstError) {

    try {
        await work(cts.Token)
    } catch (e Exception) {
        lock first.Gate {
            if first.Error == nil {
                first.Error = e
                cts.Cancel()
            }
        }
    }
}

using let cts = CancellationTokenSource()
let first = FirstError()

scope {
    for work in works {
        go child(work, cts, first)
    }
}

if first.Error != nil {
    throw first.Error!!
}
```

**G# vNext**

```gsharp
scope {
    for work in works {
        go work(ctx)
    }
}
```

> **Delta.** The pattern *is* `scope`, once `scope` is finished (D6): implicit
> `ctx`, prompt sibling cancellation on first failure, first-error propagation
> with the rest in `ScopeException.InnerExceptions`. This is the strongest
> "distinctly G#" claim in the surface — Go needs `context.WithCancel` +
> `sync.Once` + `sync.WaitGroup` + a captured `first` to say what G# says with
> a block. It is also the pattern where G# 0.4's gap between accepted design
> (ADR-0022) and shipped lowering is widest.

---

### Pattern 8 — Timeout wrapper

**Go**

```go
func DoWithTimeout(timeout time.Duration, f func() int) (int, error) {
    ch := make(chan int, 1)
    go func() { ch <- f() }()

    select {
    case v := <-ch:
        return v, nil
    case <-time.After(timeout):
        return 0, ErrTimeout
    }
}
```

**G# 0.4** — no `time.After`, so the timer is a hand-rolled goroutine plus a
one-slot channel, and `select` cannot race a `Task.Delay` directly.

```gsharp
func sendTimeout(ch chan bool, milliseconds int32) {
    Thread.Sleep(milliseconds)
    ch <- true
}

let result = make(chan Result, 1)
let timeout = make(chan bool, 1)

go runOperation(result)
go sendTimeout(timeout, milliseconds)

select {
case let value = <-result {
    return value
}
case <-timeout {
    throw TimeoutError("timed out")
}
}
```

**G# vNext**

```gsharp
func doWithTimeout[T any](timeout TimeSpan, f () -> T) T {
    let ch = make(chan T, 1)
    go func() { ch <- f() }()

    select {
    case let v = <-ch {
        return v
    }
    case <-after(timeout) {
        throw TimeoutError("timed out")
    }
    }
}
```

> **Delta.** `after(d)` (D9) is a selectable timer, not a channel fed by a
> sleeping goroutine — so the losing timer costs nothing and nothing leaks.
> The one-slot buffer is kept deliberately: it is what lets a late operation
> send and exit instead of blocking forever, and that property survives
> unchanged. `case let v = await task` (D8) covers the same shape when the
> operation is already a `Task`.

---

### Pattern 9 — Channel ownership, collection, and routing

**Go**

```go
func Producer(values ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, v := range values {
            out <- v
        }
    }()
    return out
}

func Collect(in <-chan int) []int {
    var out []int
    for v := range in {
        out = append(out, v)
    }
    return out
}

func Route(in <-chan int, evens, odds chan<- int) {
    defer close(evens)
    defer close(odds)

    for v := range in {
        if v%2 == 0 {
            evens <- v
        } else {
            odds <- v
        }
    }
}
```

**G# 0.4** — ownership is a comment, not a type. Every holder of `chan T` can
send, receive, *and* close it, and collection needs the sentinel again.

```gsharp
func produce(out chan int32?) {
    defer close(out)
    for value in values {
        out <- value
    }
}

func route(input chan int32?, evens chan int32?, odds chan int32?) {
    defer close(evens)
    defer close(odds)

    for {
        let value = <-input
        if value == nil {
            return
        }

        if value!! % 2 == 0 {
            evens <- value
        } else {
            odds <- value
        }
    }
}
```

**G# vNext** — shown with `suspend func`, the form a *published library* uses
to pin its ABI (D4, GS0560). Application code may write plain `func`.

```gsharp
suspend func produce(values []int32) in chan int32 {
    let out = make(chan int32)
    go func() {
        defer close(out)
        for v in values {
            out <- v
        }
    }()
    return out
}

suspend func collect(input in chan int32) []int32 {
    var out = []int32{}
    for v in input {
        out = append(out, v)
    }
    return out
}

suspend func route(input in chan int32, evens out chan int32, odds out chan int32) {
    defer close(evens)
    defer close(odds)

    for v in input {
        if v % 2 == 0 {
            evens <- v
        } else {
            odds <- v
        }
    }
}
```

> **Delta.** Ownership becomes checkable: `produce` returns `in chan int32`,
> so no caller can close it (GS0551); `route` takes `out chan int32`, so it
> cannot accidentally *read* the channels it is filling (GS0550). `collect`
> works at `int32` rather than `int32?` because `for v in input` terminates on
> closure, not on a reserved value. This is the pattern that most needed the
> type system, and the one the arrow-free `in`/`out` spelling reads best on.

---

### Pattern 10 — Atomic counter and once-only lazy initialization

**Go**

```go
func (c *Counter) Add(delta int64) int64 { return c.n.Add(delta) }

func (l *Lazy) Get() int {
    l.once.Do(func() { l.v = l.init() })
    return l.v
}
```

**G# 0.4**

```gsharp
import System
import System.Threading

shared {
    var counter int32
    let configuration = Lazy[Configuration](() -> Configuration.Load())
}

func increment() int32 {
    return Interlocked.Increment(ref counter)
}

func getConfiguration() Configuration {
    return configuration.Value
}
```

**G# vNext — unchanged.**

> **Delta: none.** D9 explicitly declines `sync.Once` in favour of `Lazy[T]`
> and `atomic.*` in favour of `Interlocked`. Both already give exactly-once
> execution and the memory publication guarantees Go's versions do, through
> contracts the CLR has had for two decades. Adding Go-named wrappers would
> buy familiarity and cost a second way to do it.

---

### Scorecard

| # | Pattern | G# 0.4 | G# vNext | Decisions that move it |
| --- | --- | --- | --- | --- |
| 1 | Worker pool | Expressible with caveats | **Idiomatic** | D2, D3c, D6 |
| 2 | Bounded concurrency | Supported idiomatically | **Idiomatic + no longer starves** | D4, D7 |
| 3 | Cancellable pipeline | Awkward workaround | **Idiomatic** | D3c, D6, D7 |
| 4 | Fan-in merge | Awkward workaround | **Idiomatic, and shipped as `merge`** | D3c, D6, D9 |
| 5 | TTL cache | Expressible with caveats | *unchanged* | — (ADR-0158) |
| 6 | Keyed token-bucket limiter | Supported idiomatically | *unchanged* | — |
| 7 | Structured-concurrency `All` | Awkward workaround | **Idiomatic — it *is* `scope`** | D6, D7 |
| 8 | Timeout wrapper | Expressible with caveats | **Idiomatic** | D8, D9 |
| 9 | Channel ownership and routing | Awkward workaround | **Idiomatic and type-checked** | D2, D3c, D4 |
| 10 | Atomic counter / lazy init | Supported idiomatically | *unchanged* | — |

Four "awkward workaround" ratings go to zero; three patterns are untouched by
design. **This table is the acceptance criterion for Phases 2 and 4** — each
vNext program above becomes a sample with `.golden` output, and a phase is not
done until its patterns compile and run as written here.

Two things are worth noticing about the vNext column beyond the ratings.

First, **the `nil`-sentinel protocol is gone from every example.** In 0.4 it
appears in patterns 1, 3, 4, and 9 — not because those problems have anything
in common, but because all four hit the same missing `ok`. That is the
strongest single argument for D3.

Second, **the vNext programs are shorter than the Go ones in patterns 3 and
7**, while being the same shape everywhere else. That is the target this ADR
is aiming at: not "Go, ported", but Go's model with the ceremony that Go's
own runtime forces on it — `WaitGroup` bookkeeping, `ctx.Done()` at every
blocking point — absorbed into the language.
