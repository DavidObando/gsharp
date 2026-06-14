# ADR-0043: `async func(P) R` as a type-clause spelling for `func(P) Task[R]`

- **Status**: Accepted
- **Date**: 2026-05-26
- **Phase**: Phase 7 follow-up — async ergonomics
- **Related**: ADR-0023 (async state machine), ADR-0042 (`async sequence[T]` type clause), issue #150

## Context

ADR-0023 establishes the rule that an `async func foo() R` declaration is callable as `Task[R]` (or `Task` when `R` is omitted). The `async` modifier is also legal on lambda expressions. In every other position the modifier was rejected by the parser (`Parser.cs:196`) — including type-clause positions — so users had to spell the wrapped `Task[T]` explicitly whenever they wrote a function-typed parameter, local, field, or generic argument:

```gsharp
// Before this ADR — the Task wrap leaks into the type clause.
func runEach(items []int, cb func(int) Task[int]) { ... }
let handler func(int) Task[int] = async func(x int) int { return x + 1 }
data Pipeline { transform func(int) Task[int] }
```

ADR-0042 already generalised the `async` modifier to one type-clause shape (`async sequence[T]` ⇒ `IAsyncEnumerable[T]`) and explicitly reserved the function-clause generalisation for issue #150. This ADR closes that gap.

## Decision

In any type-clause position, `async func(P1, P2, ...) R` is a spelling for `func(P1, P2, ...) Task[R]`. The alias resolves to the existing `FunctionTypeSymbol` — the two spellings denote the *same* type, not two distinct types (the same equality discipline used by ADR-0042 / ADR-0040).

```gsharp
// Local
let handler async func(int) int = async func(x int) int { return x + 1 }

// Parameter
func runEach(items []int, cb async func(int) int) {
    for x in items { _ = cb(x) }
}

// Struct field
data Pipeline {
    transform async func(int) int
}

// Generic argument / collection element
let cbs []async func(int) int = ...

// Outer function-type return slot
func factory() async func(int) int { ... }
```

### Return-slot transformations

The return-slot rules of an `async func(P) R` type clause exactly mirror the declaration-site rules (ADR-0023):

| `R` (as written)                       | Resolved return slot         |
| -------------------------------------- | ---------------------------- |
| *(omitted)*                            | `Task`                       |
| `T` (any non-Task, non-iterator type)  | `Task[T]`                    |
| `sequence[T]`                          | `IAsyncEnumerable[T]` (iterator carve-out, ADR-0041) |
| `async sequence[T]` (ADR-0042)         | `IAsyncEnumerable[T]`        |
| `IAsyncEnumerable[T]` / `IAsyncEnumerator[T]` | unchanged (iterator carve-out) |
| `Task` / `Task[X]` / `ValueTask` / `ValueTask[X]` | **diagnostic GS0189** — explicit Task wrap is disallowed because the modifier already implies it |

The double-wrap diagnostic mirrors how an `async func foo() Task[X]` *declaration* would be ill-formed (the declaration site never asks the user to spell `Task` themselves).

### Equality / assignment compatibility

`async func(int) int` and `func(int) Task[int]` are the same `FunctionTypeSymbol` — the same CLR delegate, the same overload-resolution candidate, freely assignable in either direction. There is no new conversion rule and no variance change.

### Restriction: `async` in type-clause position accepts only `func` or `sequence`

The `async` type-clause prefix now has exactly two legal successors:

- `async sequence[T]` (ADR-0042) → `IAsyncEnumerable[T]`
- `async func(...) R`  (this ADR) → `func(...) Task[R]` (with carve-outs above)

Any other follower (`async int`, `async map[K,V]`, `async chan T`, `async []T`, `async *T`, etc.) is rejected by the parser with diagnostic **GS0135** ("the `async` modifier in a type clause is only valid before `sequence[T]` or `func(...)`").

## Consequences

Positive:

- Eliminates the asymmetry between declarations (`async func foo() R`) and types (`func(...) Task[R]`). All consumer sites — parameters, locals, fields, return slots — can now read the same modifier the declaration writes.
- Zero downstream change: the resolved `FunctionTypeSymbol` is structurally identical to the explicit `Task[R]` spelling, so lowering, emit, the async state machine, overload resolution, and conversion rules see nothing new.
- Reuses the existing `async` keyword and the ADR-0042 parser entrypoint; no new reserved word, no new syntactic shape.

Negative:

- Two spellings exist for the same delegate type. Style guidance picks one canonical form; the language remains permissive.
- A user who *wants* to spell `Task[X]` explicitly inside an `async func(...)` type clause must remove either the `async` modifier or the explicit `Task` wrap. The GS0189 diagnostic makes the choice obvious.

Neutral:

- Tooling hover currently renders the resolved `FunctionTypeSymbol` with the `Task[R]` return type even when the source used the modifier spelling. Polishing the hover to render `async func(...) R` when that was the source form is nice-to-have; symbol identity is unchanged either way.

## Alternatives considered

### A. Defer indefinitely

The status quo. Rejected because the asymmetry is visible at every function-typed declaration site and the implementation cost is small (one parser branch + one binder branch).

### B. Permit explicit `Task[X]` return inside `async func(...)` (silently double-wrapping or silently no-opping)

Rejected. Silent double-wrap (`Task[Task[X]]`) is almost never what the user means and creates a subtle trap. Silently no-opping (treating `Task[X]` as already-wrapped) hides intent and makes the modifier meaningless. The diagnostic forces the user to pick a single spelling.

### C. Generalise the modifier to all type-clause prefixes (`async map[K,V]`, `async chan T`, etc.)

Rejected as overreach, for the same reasons as ADR-0042 §Alternatives D. None of the other shapes have an established BCL-side Task or AsyncEnumerable counterpart, and the modifier would lose its meaning.

## Implementation summary

Shipped in this PR as a strictly additive change. No existing program changes meaning; no existing test changes behaviour.

1. **Parser** (`src/Core/CodeAnalysis/Syntax/Parser.cs`):
   - `ParseAsyncSequenceTypeClause` is generalised to `ParseAsyncPrefixedTypeClause`. After consuming `async`, it dispatches on the next token: `func` → `ParseAsyncFunctionTypeClause`; `sequence` → the existing sequence-clause path tagged with the modifier; anything else → diagnostic GS0135 and best-effort recovery.
2. **Syntax model** (`src/Core/CodeAnalysis/Syntax/TypeClauseSyntax.cs`): the function-type constructor now records an optional `AsyncModifier` token. A new `IsAsyncFunction` property mirrors `IsAsyncSequence`, and `CreateAsyncFunction` is the corresponding factory.
3. **Binder** (`src/Core/CodeAnalysis/Binding/Binder.cs`): the `IsFunction` branch of `BindNonNullableTypeClause` applies the ADR-0023 return-slot transformations (`WrapAsTask`, iterator carve-out via `IsAsyncIteratorReturnType`) when `syntax.IsAsyncFunction` is set. A new `IsTaskShapedReturn` helper detects explicit Task/ValueTask wraps and emits diagnostic GS0189.
4. **Diagnostics**:
   - **GS0135** (existing) — message updated to mention `func(...)` alongside `sequence[T]`; helper renamed to `ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc`.
   - **GS0189** (new) — "the return type of an `async func(...)` type clause is implicitly wrapped in `Task`; do not write `Task[…]` explicitly".

No changes to lowering, emit, the async state machine, lambda inference, or any symbol code.
