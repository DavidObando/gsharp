# ADR-0023: `async func` / `await` — state-machine strategy

- **Status**: Shipped (interpreter and emit)
- **Date**: 2026-05-25
- **Phase**: Phase 5 (lock before 5.1)
- **Related**: ADR-0002 (concurrency model), ADR-0022 (go/chan/select lowering), ADR-0040 (`sequence[T]` + `yield`); execution plan §§5.1 – 5.2, 5.8; issue #51 (Roslyn-fork option)

## Context

Per ADR-0002 GSharp ships `async`/`await` for direct .NET interop alongside the Go-shaped surface. Execution-plan §5.1 calls this out as the **highest-risk single work item in the roadmap**: producing a correct IL state machine is non-trivial, and the plan explicitly names it as the trigger for re-evaluating issue #51 (Roslyn-fork) if the bespoke emitter cannot host it.

This ADR records the interpreter-side decision now (which is straightforward and unblocks the rest of Phase 5) and the framing for the emit decision (which is deliberately deferred).

## Decision

### Surface

```
async func fetch(url string) string {
    let response = await client.GetStringAsync(url)
    return response
}

let body = await fetch("https://example.com")
```

- `async` is a **modifier** on `func` declarations (free, method, extension, lambda).
- The declared return type is the **logical** return type. The actual call-site type is `Task` (when the function declares no return) or `Task[T]` (when the function declares `T`). This matches C# `async Task<T>` ergonomics: callers always see a `Task`.
- `await e` is an **expression** whose type is the unwrapped result of `e` (which must be `Task` or `Task[T]`, or any type exposing a compatible `GetAwaiter()` shape via duck-typing on the imported CLR type).
- `await` is legal only inside an `async func`, an `async` lambda, or a top-level `await` statement at script entry-point scope (mirroring C# 9 top-level statements). Use outside these contexts is a binder error.
- `Task` and `Task[T]` are first-class types in the language (imported from `System.Threading.Tasks`); the type-clause grammar admits `Task` and `Task[T]` via the existing generic-type-argument syntax (ADR-0020).

### Interpreter

The interpreter is single-threaded and stack-based. It models `async func` as **a function that returns a `Task`**:

- The body is wrapped in `Task.Run(() => Evaluator.RunBody(...))`. The wrapping evaluator owns its own locals stack; the captured outer state is the function's closure environment (already plumbed for Phase 4.7 lambdas).
- `await e` evaluates `e`, expects a `Task` / `Task[T]`, and calls `task.GetAwaiter().GetResult()` to block the calling evaluator until completion. (The evaluator is allowed to block; cooperative scheduling is a property of the emitter, not the interpreter.)
- Exceptions thrown inside the task are unwrapped (`AggregateException.InnerExceptions[0]`) and rethrown on the awaiting thread, matching C# `await` semantics.

This pragma keeps the interpreter simple and avoids implementing a continuation-passing rewrite for `await`. It is correct for all single-thread observable behavior; it is not optimal for genuine I/O parallelism inside the interpreter, which is acceptable for a language test harness.

`await for v := range stream` (§5.8) is its own statement form: the binder lowers it to `IAsyncEnumerator[T] e = stream.GetAsyncEnumerator(ct); try { while (await e.MoveNextAsync()) { let v = e.Current; … } } finally { await e.DisposeAsync() }`. The interpreter realizes each `await` with `GetAwaiter().GetResult()`.

### Emit

The emit backend implements **Strategy A — bespoke state-machine emit** from the original framing. The async rewriter operates on the bound tree (`BoundTreeRewriter`) without any Roslyn runtime dependency, producing IL that follows the canonical `IAsyncStateMachine` contract: a struct state machine with a builder field, state field, hoisted locals, and a `MoveNext()` dispatch loop. The pipeline lives inside `Compilation.LowerForEmit` and runs after binding but before `EmitAssembly`.

Key architectural choices:

- **Struct state machines** for async methods and async lambdas (value-type allocation, boxed only on first incomplete await — matching Roslyn's optimization).
- **Class state machines** for sync iterators (`IEnumerable[T]`) and async iterators (`IAsyncEnumerable[T]`), following the C# pattern where the iterator object itself serves as both enumerable and enumerator for the initial thread.
- Lowering passes run in a fixed order: `AsyncExceptionHandlerRewriter` → `SpillSequenceSpiller` → `RefInitializationHoister` → `AsyncCaptureWalker` → state-machine rewriter (with MoveNext body rewriter as a sub-pass).
- Synthesized state-machine types nest privately inside the declaring type (`<Program>` for top-level functions; closure class for capture-bearing lambdas), matching the Roslyn convention for debugger/reflection discovery.
- Sequence-point markers (`AwaitYieldPoint` / `AwaitResumePoint`) are emitted as `nop` bytes today, awaiting a future PDB writer.
- Awaitable-shape resolution is duck-typed: any type exposing a compatible `GetAwaiter()` pattern (including `Task.Yield()`, `ValueTask`, and structural awaitables) is accepted.

See `docs/emit-pipeline.md` for the full pass-ordering diagram and typedef layout.

## Implementation summary

The async emitter shipped end-to-end across PRs #106–#135, building on the interpreter-side work from the original acceptance and the pre-async gap closure in #98.

### Foundations

- **#98** — interpreter↔emitter gap closure (Phases A–G); async deferred per this ADR.
- **#106** — foundational lowering scaffolding (ADR-0023 Strategy A).
- **#107** — `AsyncCaptureWalker` (hoist-set analysis).
- **#108** — `AsyncStateMachineTypeBuilder` factory.
- **#109** — `AsyncEmitPrecheck` (clean diagnostic instead of bad IL).
- **#110** — struct materialization for synthesized state machines.
- **#111** — state-machine field map.
- **#112** — resumable state allocator.
- **#113** — state-machine rewriter scaffold.
- **#114** — MoveNext body plan.
- **#115** — kickoff body plan.
- **#116** — kickoff operation ordering.
- **#118** — kickoff body emission.
- **#119** — MoveNext per-await dispatch (straight-line).

### Lowering passes

- **#121** — `SpillSequenceSpiller` (lift await out of sub-expressions).
- **#122** — `AsyncExceptionHandlerRewriter` (spec §8).
- **#123** — `RefInitializationHoister` (decompose ref locals across await).

### Producer-side iterators

- **ADR-0040 + #124** — `sequence[T]` type alias and `yield` keyword (sync iterators).
- **#128** — `IAsyncEnumerable[T]` with mixed `yield` + `await` (async iterators).

### Feature surface

- **#125** — `BoundDefaultExpression` + `initobj` (value-type awaiter clear).
- **#126** — awaitable-shape generalization (`Task.Yield()` / `ValueTask` / structural awaitables).
- **#127** — async lambdas.

### Polish

- **#129** — sequence-point markers (§9: `AwaitYieldPoint` / `AwaitResumePoint`).
- **#130** — `LowerForEmit` consolidation (extract pipeline helper; deduplicate Emit overloads).
- **#131** — precheck cleanup + reflection invariants.
- **#133** — nested-private state-machine types (Roslyn convention parity).

### Verification

- **#134** — white-box unit tests for async/iterator lowering rewriter passes.
- **#135** — interp↔emit parity harness + `AsyncTask.gs` conformance promotion + `go`-on-async fix.

## Known limitations / follow-ups

Filed issues tracking incomplete edges of the async/iterator surface:

- **#132** — `return await X` leaks un-rewritten `BoundAwaitExpression` to emitter.
- **#136** — async `try`/`catch` around `await` → `InvalidProgramException` at runtime.
- **#137** — async `try`/`finally` around `await` → `InvalidProgramException` at runtime.
- **#138** — interpreter lacks `yield` (sync and async iterators); blocks parity for any iterator-using program.

Smaller deferrals carried in commit messages:

- `[EnumeratorCancellation]` parameter forwarding (§10 advanced).
- `asyncSequence[T]` alias for `IAsyncEnumerable[T]` — addressed by ADR-0041 (proposes context-sensitive `sequence[T]` instead of a new keyword).
- Iterator `try`/`finally` support (`Dispose()` resuming into finally blocks).
- Extension-method `GetAwaiter()` resolution.
- `AsyncMethodBuilderInfo` for `ValueTask`/`ValueTask<T>` return types.
- Pre-existing parser bug — generic return type + params combo.
- User-facing `default` syntax (`BoundDefaultExpression` is internal-only today).

## Consequences

- New `SyntaxKind`s: `AsyncKeyword`, `AwaitKeyword`; new modifier slot on `FunctionDeclarationSyntax` and lambda syntax.
- New bound forms: `BoundAwaitExpression`. (`async` itself flows through `FunctionSymbol.IsAsync` and does not need its own bound node.)
- Binder rules: `await` only inside async context; an `async func` declared `T` is callable as `Task[T]` everywhere; `await` is the only legal way to consume a `Task[T]` for its value (other than `.Result` via CLR interop, which we accept as an escape hatch).
- Interpreter takes a synchronous-blocking `await`. Tests must therefore not assert thread-id continuity across `await`; document the constraint in the conformance harness header.
- Both backends (interpreter and emit) now cover `async`/`await`. The coverage matrix reflects ✅ interp, ✅ emit for async-method and async-lambda surfaces. Iterator surfaces are emit-only pending #138.

## Alternatives considered

- **Implement `await` as a continuation rewrite in the bound tree** (CPS transform). Rejected for the interpreter: complexity is not paid for by user-visible behavior since the interpreter is single-threaded. Re-evaluate for emit.
- **Forbid `await` inside `try`/`catch`/`finally` in this PR.** Rejected: ergonomically intolerable, and the interpreter handles it naturally because each `await` is a synchronous block.
- **Ship emit alongside interpreter in this PR.** Rejected: the plan explicitly flags this as the project's highest single-item risk; bundling it would risk losing the rest of Phase 5 to that one item.

## Open follow-ups

- Async lambdas (`async func(x int) int { … }`) — shipped in #127 for both interpreter and emit.
- `ValueTask` / `ValueTask[T]` — duck-typed via `GetAwaiter()` and accepted at the language level (#126); `AsyncMethodBuilderInfo` for native `ValueTask` return (avoiding the Task wrapper) is deferred.
- Cancellation token plumbing into `await for` — interpreter uses the enclosing `scope { }`'s CTS when present; standalone `await for` uses `CancellationToken.None`. `[EnumeratorCancellation]` forwarding is deferred.
