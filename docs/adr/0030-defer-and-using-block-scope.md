# ADR-0030: `defer` and block-scoped cleanup convergence

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 7.1
- **Related**: Phase 3.D.3 `using` declarations; execution plan row 7.1

## Context

Phase 7.1 adds a `defer` statement lowered to `try { … } finally { deferredCall() }` at scope exit, with reverse-order execution like Go. GSharp already has Phase 3.D.3 `using` declarations, but the original implementation lowered `using let x = expr` to a declaration followed by an empty protected block and a `finally`, which meant disposal occurred at scope exit but did not actually protect subsequent statements from exceptions. Go's `defer` is function-scoped, but GSharp's existing cleanup story is block-oriented through lexical scopes and `using` declarations.

## Decision

Add `defer call(arg1, arg2, …)` as a statement. The operand must bind to a call expression: `BoundCallExpression`, `BoundIndirectCallExpression`, `BoundUserInstanceCallExpression`, `BoundImportedCallExpression`, or `BoundImportedInstanceCallExpression`; any other operand is rejected with a `defer`-specific diagnostic.

Deferred call arguments are evaluated eagerly when the `defer` statement executes. Binding synthesizes immutable locals using names with the `$defer$arg$` prefix, initializes each local from the corresponding argument expression at the defer point, and substitutes those locals into the call that runs later.

`defer` is block-scoped and LIFO. A `defer` runs when the enclosing block exits normally or exceptionally. Multiple `defer` statements in the same block lower to nested `try/finally` statements so later source declarations execute first at exit.

`using` declarations share the same block cleanup lowering. `using let x = expr` binds the declaration at the point it appears, then wraps the remaining statements in the enclosing block in `try/finally` with `x.Dispose()` in the `finally`. Interleaved `defer` and `using` declarations compose as one LIFO cleanup stack.

`await using let x = expr` (issue #605) is the async sibling: it probes for `DisposeAsync()` returning `ValueTask` (the `IAsyncDisposable` pattern) and lowers to `try/finally` with `await x.DisposeAsync()` in the `finally`. It requires `async func` context and follows the same scope-exit machinery. When a type implements both `IDisposable` and `IAsyncDisposable`, `await using let` calls `DisposeAsync` and plain `using let` calls `Dispose`.

## Rationale for block scope over function scope

Block scope keeps the Phase 7.1 lowering small and local to block binding. It composes cleanly with `using`, `if`, `for`, `scope`, and ordinary nested blocks because each construct already has a lexical block boundary that can own cleanups. It also matches every other scope-cleanup mechanism in the language rather than introducing a second whole-function post-pass just for `defer`. If a future sample requires Go-exact semantics, GSharp can add a `defer-fn` variant or upgrade to function-scoped semantics without breaking programs that already rely on block-scoped cleanup.

## Consequences

Positive:

- `using` now provides real exception protection for subsequent statements in the same block.
- `defer` and `using` compose predictably through one nested `try/finally` lowering.
- The implementation does not add a public bound-tree node; `defer` is eliminated during binding.

Neutral:

- Synthesized `$defer$arg$…` locals may appear in bound-tree debug output.

Negative:

- GSharp's `defer` differs from Go's function-scoped `defer`, so ported Go code that depends on function-scope lifetime must add an enclosing block or wait for a future function-scoped form.

## Alternatives considered

Go-style function-scoped `defer` was rejected for this phase because it requires a larger transformation over the whole function body after binding and does not naturally share machinery with `using` declarations.

An attribute-based opt-in cleanup mechanism was rejected because it is non-orthogonal to the existing statement-level scope-cleanup story and would make ordinary control flow depend on metadata rather than syntax.
