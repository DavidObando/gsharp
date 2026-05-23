# ADR-0023: `async func` / `await` — state-machine strategy

- **Status**: Accepted (interpreter); deferred (emit)
- **Date**: 2026-05-23
- **Phase**: Phase 5 (lock before 5.1)
- **Related**: ADR-0002 (concurrency model), ADR-0022 (go/chan/select lowering); execution plan §§5.1 – 5.2, 5.8; issue #51 (Roslyn-fork option)

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

Emit is **deferred** out of this PR. The work splits into two strategies; we commit to the choice in Phase 7 alongside the broader Roslyn-fork question (ADR-0027).

**Strategy A — bespoke state-machine emit.** Replicate Roslyn's `AsyncMethodToStateMachineRewriter` against our `BoundTreeRewriter`. Multi-month effort. Owns the long-tail of edge cases (try/catch around awaits, finally with awaits, loops with awaits, structured locals across await points).

**Strategy B — Roslyn-borrowed lowering.** Re-host Roslyn's async rewriter on our bound tree (the project already vendors a Roslyn submodule under `src/Roslyn/`). Risk: tight coupling to Roslyn's BoundNode shape; ongoing maintenance against upstream churn.

The deciding inputs we expect to have by Phase 7:

- Real-world async sample volume (Phase 5 samples + Phase 6/7 user testing).
- Whether the bespoke emitter has hosted enough lowering features by then to make Strategy A's incremental cost feel finite.
- The Phase 7 ADR-0027 outcome on issue #51.

Until then the interpreter is the only conformance backend for `async`/`await`. The coverage matrix and conformance harness record this explicitly (✅ interp, ❌ emit) so the gap is visible.

## Consequences

- New `SyntaxKind`s: `AsyncKeyword`, `AwaitKeyword`; new modifier slot on `FunctionDeclarationSyntax` and lambda syntax.
- New bound forms: `BoundAwaitExpression`. (`async` itself flows through `FunctionSymbol.IsAsync` and does not need its own bound node.)
- Binder rules: `await` only inside async context; an `async func` declared `T` is callable as `Task[T]` everywhere; `await` is the only legal way to consume a `Task[T]` for its value (other than `.Result` via CLR interop, which we accept as an escape hatch).
- Interpreter takes a synchronous-blocking `await`. Tests must therefore not assert thread-id continuity across `await`; document the constraint in the conformance harness header.
- Emit gap is recorded explicitly. Phase 5 exit criterion drops the "both backends" half for async-bearing samples and notes the matrix gap.

## Alternatives considered

- **Implement `await` as a continuation rewrite in the bound tree** (CPS transform). Rejected for the interpreter: complexity is not paid for by user-visible behavior since the interpreter is single-threaded. Re-evaluate for emit.
- **Forbid `await` inside `try`/`catch`/`finally` in this PR.** Rejected: ergonomically intolerable, and the interpreter handles it naturally because each `await` is a synchronous block.
- **Ship emit alongside interpreter in this PR.** Rejected: the plan explicitly flags this as the project's highest single-item risk; bundling it would risk losing the rest of Phase 5 to that one item.

## Open follow-ups

- Async lambdas (`async func(x int) int { … }`) — included in the interpreter pass; emit follow-up tracks them with the rest.
- `ValueTask` / `ValueTask[T]` — duck-typed via `GetAwaiter()`; explicit support TBD when usage demands.
- Cancellation token plumbing into `await for` — interpreter uses the enclosing `scope { }`'s CTS when present; standalone `await for` uses `CancellationToken.None`. Revisit in Phase 7.
