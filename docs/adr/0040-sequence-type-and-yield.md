# ADR-0040: `sequence[T]` type alias and `yield` statement

- **Status**: Proposed
- **Date**: 2026-05-26
- **Phase**: Phase 7 follow-up — iterator support
- **Related**: ADR-0023 (async state machine), ADR-0031 (canonical `for x in collection`), ADR-0034 (imported CLR interop), ADR-0039 (by-ref pointers)

## Context

GSharp already supports consumer-side iteration via `for x in collection` (ADR-0031), which works on arrays, slices, dictionaries, `IEnumerable[T]`, non-generic `IEnumerable`, and pattern-based `GetEnumerator()`. However, there is no producer-side iterator syntax — users cannot define lazy sequences that yield values one at a time. This means custom iteration logic must allocate a full collection up-front or implement the `IEnumerator[T]` interface manually, neither of which is ergonomic.

The async state-machine infrastructure (ADR-0023) has established patterns for synthesized types, field maps, kickoff stubs, and `MoveNext` bodies. The sync iterator pattern is simpler (no builder, no awaiter) and can leverage the same architectural patterns.

Async iterators (`IAsyncEnumerable[T]`) are aspirational but blocked until sync iterators are solid. This ADR covers sync iterators only.

## Decision

### 1. Introduce `sequence[T]` as a type alias for `IEnumerable[T]`

By analogy with `map[K]V` aliasing `Dictionary[K, V]` (Phase 3.A.4), `sequence[T]` is the GSharp-flavored spelling of `System.Collections.Generic.IEnumerable<T>`. Both forms are interchangeable in declarations, parameter types, return types, and assignments. At the CLR metadata level they are the same type — no wrapper, no indirection.

The `sequence` keyword is contextual: it is recognized only in type-annotation position (before `[`), and remains a valid identifier elsewhere.

### 2. Introduce `yield <expr>` statement

`yield <expr>` produces the next value of the enclosing iterator function. It is legal only in functions whose return type is one of:
- `IEnumerable[T]` (equivalently `sequence[T]`)
- `IEnumerator[T]`
- `IEnumerable` (non-generic)
- `IEnumerator` (non-generic)

A function containing any `yield` statement becomes an *iterator function*. The `<expr>` must be assignable to the element type of the enclosing iterator's return type.

### 3. `yield break` is not supported

This slice does not implement `yield break`. The GSharp answer for early termination of an iterator is plain `return` — running off the end of the function body or executing `return` causes `MoveNext()` to return `false`. This is consistent with Go's approach where `return` is the single exit mechanism, and avoids a two-keyword statement form that has no analog in Go or Kotlin.

### 4. Async iterators deferred

`IAsyncEnumerable[T]` and `await foreach`-style async iteration are a separate future slice. The `sequence[T]` alias is sync-only; an `async_sequence[T]` or equivalent will be designed when that work begins.

## Surface syntax

### `sequence[T]` type

Parses identically to `map[K]V`: the contextual keyword `sequence` followed by `[`, a type clause, and `]`. Example:

```gsharp
func fib(max: int) sequence[int] {
    a, b := 0, 1
    for a <= max {
        yield a
        a, b = b, a+b
    }
}
```

### `yield <expr>` statement

Parses as a statement. The keyword `yield` is contextual — it is recognized as a keyword only when it appears as the first token of a statement and is followed by an expression (not a semicolon, `}`, or EOF). The bare identifier `yield` remains legal as a variable name:

```gsharp
yield := 42          // legal: short variable declaration
fmt.Println(yield)   // legal: yield as identifier
yield x + 1          // legal: yield statement in an iterator function
```

Disambiguation: at statement-start position, if the current token text is `"yield"` and the next token is not `:=`, `++`, `--`, `,`, `.`, `(`, `[`, `=`, or an assignment operator, it is parsed as a yield statement. Otherwise it falls through to expression/assignment parsing where `yield` is treated as an identifier.

## Semantics

The execution model is identical to C#'s iterator state machine:

1. **Lazy**: calling an iterator function returns immediately with an `IEnumerable[T]` instance. No user code runs until the first `MoveNext()`.
2. **Deferred side-effects**: side effects in the function body execute only when `MoveNext()` is called.
3. **One-shot per enumeration**: each call to `GetEnumerator()` returns a fresh enumerator that starts from the beginning. The initial instance can serve as both `IEnumerable[T]` and `IEnumerator[T]` for the first enumeration (thread-id optimization).
4. **Composition with `for x in`**: because iterator functions return `IEnumerable[T]`, they compose naturally with the existing `for x in seq` consumption (ADR-0031).

## Codegen approach

Synthesize a sealed class implementing `IEnumerable<T>`, `IEnumerator<T>`, `IDisposable`:

- **Fields**: `<>1__state` (int), `<>2__current` (T), `<>l__initialThreadId` (int), parameter proxies, hoisted locals.
- **`MoveNext()`**: state-dispatch switch at entry; each `yield x` becomes `current = x; state = K; return true; resumeK: state = -1;`. End of body: `state = -1; return false;`.
- **`get_Current`**: returns `<>2__current`.
- **`Dispose()`**: `state = -1` (no try/finally support this slice).
- **`Reset()`**: throws `NotSupportedException`.
- **`GetEnumerator()`**: if `state == -2 && threadId == initialThreadId`, transitions to state 0 and returns `this`; otherwise allocates a fresh instance with parameters copied.
- **Non-generic `IEnumerator.Current`**: boxes via the generic property.

The original function body is replaced with a kickoff stub: allocate the state machine with `state = -2`, copy parameters, return.

This reuses architectural patterns from the async state-machine pipeline (`SynthesizedStateMachineType`, `ResumableStateAllocator`, etc.) but is a separate, simpler lowering pass since there is no builder or awaiter machinery.

## Interop

`sequence[T]` and `IEnumerable[T]` are the same type at the CLR metadata level. Functions declared with either spelling produce identical IL. Mixing both forms in a single program is well-defined. Values flow freely between GSharp iterators and .NET LINQ, `foreach`, and any other `IEnumerable[T]` consumer.

## Diagnostics

| ID | Message |
|---|---|
| GS9101 | `yield` statement is not allowed outside an iterator function |
| GS9102 | Iterator function must return `IEnumerable[T]`, `IEnumerator[T]`, `IEnumerable`, or `IEnumerator` |
| GS9103 | Cannot convert yielded expression of type `{actual}` to iterator element type `{expected}` |
| GS9104 | `yield break` is not supported; use `return` to end iteration |

## Open questions

1. **Async iterators**: `IAsyncEnumerable[T]` support is deferred. Will likely introduce `async_sequence[T]` or reuse `sequence[T]` in async context.
2. **Try/finally in iterators**: this slice does not support `try`/`finally` within iterator bodies (would require `Dispose()` to resume into finally blocks). A diagnostic is emitted if detected.
3. **Interpreter parity**: the interpreter (`Evaluator.cs`) does not gain `yield` support in this slice. Iterator functions are emit-only. This is a known gap — the interpreter is authoritative per `docs/emit-pipeline.md` but iterator state machines are inherently an emit concern. Interpreter parity is tracked as follow-up work.

## Alternatives considered

### A. Generator functions with `func*` syntax

A Go-style channel-based generator (`func fib() chan int`) was considered but rejected because it requires goroutine allocation per iteration, has different lifetime semantics, and doesn't compose with LINQ or `foreach`.

### B. Reserved `yield` keyword

Making `yield` a hard keyword was rejected because it would break any existing code using `yield` as a variable name and is inconsistent with the contextual-keyword precedent set by `in` (ADR-0031) and variance markers (ADR-0021).

### C. `yield return` two-keyword form (C# style)

Rejected in favor of bare `yield <expr>` for brevity and Go/Kotlin flavor. The `return` in C#'s `yield return` is vestigial — it aids disambiguation in C#'s grammar but is unnecessary in GSharp where `yield` is unambiguous at statement start.

## Summary

This ADR introduces producer-side iterator support via `sequence[T]` (alias for `IEnumerable[T]`) and `yield <expr>`. The feature uses a synthesized state-machine class following the well-established C# iterator pattern, reuses architectural patterns from the existing async pipeline, and composes naturally with the already-shipped `for x in` consumption syntax. `yield break` is omitted in favor of plain `return`; async iterators are deferred.
