# ADR-0002: Concurrency model — Go surface, .NET runtime, Kotlin scopes

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 5 (implementation), Phase 0 (lock)
- **Related**: gaps doc §2.6, §3.3, §6.4; execution plan §0 D2, §5; design doc D2

## Context

GSharp's gap analysis identifies three credible concurrency precedents — Go (`go`/`chan`/`select`), C# (`async`/`await`), Kotlin (`suspend` + structured scopes) — and warns that GSharp cannot afford all three as parallel models. Yet each one carries unique value:

- Go's surface is the language's identity statement.
- `async`/`await` is mandatory for unmodified BCL interop (`HttpClient`, `Task.WhenAll`).
- Kotlin's structured concurrency is the best-understood model for cancellation and supervision.

## Decision

A **synthesis**: surface all three, lower onto a single runtime.

- **Surface syntax**: Go-shaped (`go f()`, `chan T`, `<-`, `select`) for goroutine-channel programming; `async func` and `await` for direct BCL interop; structured-concurrency `scope { ... }` blocks as the supervision primitive.
- **Runtime lowering**: `go f()` → `Task.Run(() => f())` (or scope-tracked task inside a `scope`); `chan T` → `System.Threading.Channels.Channel<T>`; `<-` → `Channel<T>.Reader/Writer` operations (async in `async` contexts, blocking otherwise); `async func` → standard .NET state machine.
- **Cancellation**: `scope` propagates a `CancellationToken`; spawned goroutines fail-fast on first exception by default, aggregate per ADR-0005 conventions.

## Consequences

Positive:

- Preserves GSharp's Go identity while remaining a first-class .NET citizen.
- One runtime, three surfaces — easy to reason about; no opaque Kotlin-style continuation library to maintain.
- Structured scopes give a principled answer to "what happens if a goroutine throws."

Negative:

- Async state-machine emit is the single highest-risk work item in the entire roadmap; if our bespoke emitter cannot host it cleanly, this is the trigger to revive issue #51 (Roslyn fork).
- Three surfaces means three sets of diagnostics, three teaching stories, and a risk of style fragmentation. Mitigation: ship style guidance in the v1.0 spec.

Neutral:

- `select` semantics need a precise spec (ADR-0022) because Go and `Channel<T>.WaitToReadAsync` differ in subtle ways.

## Alternatives considered

- **`async`/`await` only**: simplest, but throws away GSharp's Go identity.
- **`go`/`chan`/`select` only**: most Go-faithful, but forces awkward bridges for unmodified BCL APIs.
- **Defer to a later phase**: rejected; the language design cannot stabilize without a concurrency story.
