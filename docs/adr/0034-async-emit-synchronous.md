# ADR-0034: Async emit — match the interpreter's synchronous semantics for v1.0

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 7.8 (post-PR-#98 emit-gap closure)
- **Related**: ADR-0022 (go/chan/select lowering), ADR-0023 (async state machine — interpreter side and Strategy A/B emit options), ADR-0027 (bespoke emitter for v1.0), PR #98 (Phases A–G + I)

## Context

PR #98 closed every interpreter ↔ emitter gap **except** `async func` / `await` / `await for`. That remaining gap is exactly what ADR-0023 §Emit deferred, with two named strategies:

- **Strategy A** — bespoke `IAsyncStateMachine` rewriter against our `BoundTreeRewriter`.
- **Strategy B** — re-host Roslyn's async rewriter on our bound tree.

ADR-0023 also classifies Strategy A as the project's "highest single-item risk" and a "multi-month effort"; ADR-0027 then closed the Roslyn-fork option for v1.0, so Strategy B is also off the table for v1.0. A naive reading of those two ADRs in sequence is that async emit cannot ship before v1.0 at all.

However, ADR-0023 §Interpreter is the canonical specification of **what async means in GSharp**, and the interpreter explicitly chose *synchronous* semantics:

> The interpreter is single-threaded and stack-based. It models `async func` as a function that returns a `Task` … `await e` evaluates `e`, expects a `Task` / `Task[T]`, and calls `task.GetAwaiter().GetResult()` to block the calling evaluator until completion.

The actual code (`Evaluator.cs`) is even simpler than the ADR text: `EvaluateCallExpression` runs the async function body straight through on the calling stack, and `WrapAsyncResult` wraps the produced return value in `Task.FromResult` on the way out. There is no `Task.Run`, no second thread, no continuation.

This is exactly the semantic surface PR #98's emit-gap closure needs to match. Strategies A and B are required only if we want emit to deliver *more* than the interpreter — i.e. real continuation-passing rewriting with single-thread suspension across `await`. They are not required to close the interpreter ↔ emit gap. They are *bigger* than the gap.

## Decision

For v1.0, emit `async func` and `await` with **synchronous semantics that mirror the interpreter byte-for-byte**:

1. **`async func foo() T { … }` emits as a regular CLR method** whose declared return type is `Task` (when `function.Type == Void`) or `Task<T>` (otherwise). No synthesized `IAsyncStateMachine` value type, no `AsyncTaskMethodBuilder` plumbing, no `MoveNext`, no `[AsyncStateMachine]` attribute.
2. **The function body emits as-is** — a normal sequence of bound statements compiled into IL the same way any sync method's body is compiled. Locals stay on the CLR stack; control flow stays linear.
3. **`return e` inside an `async func`** emits as `Task.FromResult<T>(e); ret` for non-void async funcs and as `ldsfld Task.CompletedTask; ret` for void async funcs. Implicit "fall off the end" of a void async body emits the same `ldsfld Task.CompletedTask; ret` epilogue.
4. **`await e`** emits as `e; stloc <awaiter>; ldloca <awaiter>; call GetResult()`. The awaiter (`TaskAwaiter` or `TaskAwaiter<T>`) is a value type, so a scratch local is reserved per await site by the existing pre-pass walker (Phase E precedent). `GetAwaiter()` is an instance method on a closed generic type and routes through `GetMethodReference`; `Task.FromResult<T>` is a generic static method and routes through `GetMethodEntityHandle` (Phase E `MethodSpec` infrastructure).
5. **Async lambdas (`async func(x int) int { … }`)** stay deferred. The binder produces them today; emit continues to reject them with a clear `NotSupportedException` until a follow-up lowering pass lifts them onto the existing synthesized-display-class infrastructure (Phase F precedent). The aspirational `AsyncTask.gs` sample does not exercise them.
6. **`await for v := range stream`** stays deferred. Emit continues to reject `BoundAwaitForRangeStatement` with `NotSupportedException`. The interpreter handles it via the `IAsyncEnumerator` / `MoveNextAsync` pattern documented in ADR-0023; matching emit needs a try/finally with an `await DisposeAsync()` arm and is best landed once the bespoke try/await interaction has a separate ADR. ADR-0022 §Open follow-ups already tracks this.

## Why this is correct (vs. ADR-0023's Strategy A)

Strategy A and the "synchronous" approach are different points on a correctness/performance trade-off — not different points on a correctness scale. Both are correct for every program whose user-observable semantics are "block on `await`". GSharp's *interpreter* is the spec; PR #98 made the *emitter* its dual. The emitter's job is to produce the same observable behaviour the interpreter produces. The interpreter already chose to block synchronously on `await`. Emit therefore satisfies the gap-closure contract by also blocking synchronously on `await`.

Strategy A buys two things on top of the synchronous approach:

- **Genuine I/O parallelism inside a single thread.** A real state machine yields control on await so other work can run on the same scheduler. The interpreter does not do this; therefore parity does not require emit to do it either. Users who want real parallelism use `go func() { … }` (Phase F) or `scope { go … }` (Phase F) — that path already gives them genuine fan-out.
- **Cooperative scheduling with `SynchronizationContext` / `TaskScheduler.Current`.** The synchronous approach captures whatever scheduler the caller happens to be on, which can deadlock on a UI-thread-bound `SynchronizationContext`. GSharp v1.0 does not target UI frameworks; the interpreter has the same limitation; and the documented work-around (drive async entry points from `scope { go runAll() }`, exactly as the `AsyncTask.gs` sample does) sidesteps the deadlock.

Both of those affordances are post-v1.0 features. They are out of scope for closing the interpreter ↔ emit gap, which is the only contract PR #98 was chartered to satisfy.

## What this PR (and its successor) deliver

- `EmitFunction` recognises `function.IsAsync` and rewrites the emitted method's return type to `Task` / `Task<T>`.
- `BoundReturnStatement` emit consults the enclosing function and wraps the value (or emits `Task.CompletedTask`) when the enclosing function is async.
- A new `BoundAwaitExpression` dispatch case in `EmitExpression` emits the `GetAwaiter().GetResult()` pattern using a pre-allocated awaiter scratch slot.
- The pre-pass walker (`WalkForPatternSwitches` / `WalkExpressionForSwitches`) gains `BoundAwaitExpression` cases that allocate the awaiter slot before the locals signature is finalised.
- `samples/aspirational/AsyncTask.gs` is promoted to `samples/AsyncTask.gs`, the matching `*.golden` follows, and the conformance harness covers it end-to-end on the emit backend.
- The coverage matrix flips the `async func` and `await e` Emit cells to ✅. `await for` keeps its `—`, with a note pointing at the ADR-0022 §Open follow-up.

## Consequences

### What gets closed

- **The interpreter ↔ emit gap is closed for every Phase 5 surface except `await for`.** All other bound nodes the binder can produce are now reachable through both backends; the `samples/` directory is the conformance witness on both.
- **`AsyncTask.gs` lives at top-level samples.** The aspirational README is reduced to one outstanding sample (`await for`-bearing follow-ups, when one is written) — or, if nothing remains, the aspirational README is reduced to a one-line "no current contents" note and the directory itself becomes a tracking placeholder.

### What this explicitly forgoes (and accepts) for v1.0

- **No real continuation rewrite.** `await` does not yield the calling thread; the emitted async function runs as a synchronous method that happens to return `Task<T>`. Programs that rely on observable suspension across `await` (e.g. assertions on `Thread.CurrentThread.ManagedThreadId` continuity across an `await` boundary) will see a different answer than the same program in C#. GSharp's documentation and the conformance harness header already warn against this assumption (ADR-0023 §Consequences). The synchronous emit is *more* permissive than the interpreter, not less: any program correct under the interpreter remains correct under emit, with identical observable behaviour.
- **No `[AsyncStateMachine]` / `[DebuggerStepThrough]` decoration.** Without a synthesized state-machine type there is nothing to point the attribute at. The debugger steps into `await` as a regular method call — which is exactly what it is at IL level. Async stack-trace stitching (`AsyncMethodBuilder`-based) does not apply; the call stack is the genuine synchronous call stack.
- **No async-aware deadlock avoidance on captured contexts.** A `SynchronizationContext`-bound caller that `await`s a `Task` produced inside an `async func` *on the same context* can deadlock. GSharp v1.0 ships no UI runtime and `AsyncTask.gs` is driven from a script-mode `scope { go runAll() }` precisely because that is the documented driver shape. The deadlock is the same one a C# program would hit if it called `.GetAwaiter().GetResult()` instead of `await` — and GSharp's emit is, in essence, doing exactly that.

### Path back to Strategy A (post-v1.0)

The synchronous emit is a complete replacement, not a stepping stone. If post-v1.0 we add a UI runtime, or users discover correctness gaps in synchronous semantics that the interpreter spec needs to grow to cover, we revisit ADR-0023 and pick up Strategy A as a separate work item. The synchronous-emit code path can stay or be removed at that point; nothing in this ADR pins us either way. The vendored `src/Roslyn` tree (still present per ADR-0027) remains available as a Strategy-B fallback if Strategy A's cost is judged too high a second time.

## Alternatives considered

**Defer async emit to a post-v1.0 release.** Rejected. The interpreter ↔ emit gap is a release blocker for the Phase 7 "both backends green" contract; leaving one surface unsupported makes the matrix permanently asymmetric and forces users to remember which constructs they can only test on the interpreter. Synchronous-mirror emit closes the gap with bounded effort.

**Implement Strategy A in a minimal "linear bodies only" form** (no try-around-await, no loop-around-await). Rejected for now. A partial state machine adds significant complexity (synthesized struct TypeDef, `IAsyncStateMachine` interface impl, kickoff method emit, `AsyncTaskMethodBuilder` plumbing, exception-trap rewriting) for no incremental observable benefit over the synchronous approach. The cost-benefit only shifts if a non-synchronous async program enters the GSharp test surface — which is itself a Phase-8 question. Until then, Strategy A buys nothing the synchronous mirror does not already deliver.

**Lower `await e` to `e.Wait()` (instead of `e.GetAwaiter().GetResult()`).** Rejected. `.Wait()` re-throws exceptions as `AggregateException`; the interpreter's `await` re-throws the inner exception directly via the awaiter's `GetResult()`. Matching the interpreter requires the awaiter path.

**Emit async funcs without `Task` wrapping at all** (i.e., `async func compute() int` emits a method returning `int`). Rejected. The binder treats async call sites as `Task[T]` (`Binder.cs:4208` `WrapAsTask`), so call-site expressions already have type `Task[T]`. Emitting a method with the unwrapped return type would lie about the contract and break any code that holds onto the returned `Task` (including `go`-spawned async functions, which Phase F emits as `Task.Run(() => asyncFunc())`).

## Open follow-ups

- `await for v := range stream` emit — separate ADR alongside its `try { … } finally { await e.DisposeAsync() }` lowering (tracked in ADR-0022 §Open follow-ups).
- Async lambda emit — lift onto the Phase F display-class infrastructure when a sample demands it.
- Strategy A revisit — only if real continuation semantics become a release blocker post-v1.0.
