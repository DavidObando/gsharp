# ADR-0041: `sequence[T]` in an `async` context aliases `IAsyncEnumerable[T]`

- **Status**: Accepted (implemented in this PR)
- **Date**: 2026-05-25
- **Phase**: Phase 7 follow-up — iterator ergonomics
- **Related**: ADR-0002 (concurrency model), ADR-0022 (`<-` is async in async contexts), ADR-0023 (async state machine), ADR-0040 (`sequence[T]` + `yield`)

## Context

ADR-0040 introduced `sequence[T]` as a contextual-keyword alias for `System.Collections.Generic.IEnumerable<T>`, and ADR-0023 shipped `IAsyncEnumerable[T]` support for async iterators in #128. Both ADRs leave one ergonomic edge open (ADR-0040 §"Open questions" item 1; ADR-0023 §"Known limitations" "asyncSequence[T] alias"): users wanting an async iterator must spell the BCL type by hand, e.g.

```gsharp
async func numbers() IAsyncEnumerable[int] { yield 1; await Task.Delay(10); yield 2 }
```

while the sync flavor enjoys the GSharp-flavored alias:

```gsharp
func numbers() sequence[int] { yield 1; yield 2 }
```

The asymmetry is jarring. Two ergonomic spellings are credible:

- **A separate alias** `asyncSequence[T]` (the path implied by the ADR-0023/0040 follow-ups).
- **Overload the existing alias**: `sequence[T]` continues to mean `IEnumerable[T]` everywhere except in the return-type position of an `async func`, where it means `IAsyncEnumerable[T]`. This is the user proposal evaluated here.

A precedent for concurrency-context-dependent semantics already exists in GSharp: ADR-0022 specifies that channel `<-` operations lower to async `Reader`/`Writer` calls inside `async` contexts and blocking calls otherwise. The surface token is identical; the lowering target depends on the enclosing function's `async`-ness.

## Feasibility assessment

Mechanically, the change is small and local to the binder and one symbol class. The grammar is unchanged — `sequence` remains a contextual keyword recognized in type-clause position. The work splits as follows.

### Binder (one new flow)

`Binder.BindTypeClause` would need to know, when it encounters `IsSequence`, whether the *current binding context* is the return-type position of an `async` function (free function, method, extension, or lambda). The `IsAsync` flag is already on `FunctionDeclarationSyntax` and on the lambda syntax. Two viable shapes:

1. **Peek the enclosing syntax**: walk `syntax.Parent` (or have `BindFunctionDeclaration`/`BindLambda` pass a boolean) when binding the *return type clause specifically*. This is cleanly scoped — the rule applies only to the return-type slot, never to parameter types, local declarations, generic arguments, or any other type-clause site.
2. **Bind eagerly to `SequenceTypeSymbol` and rewrite later** when the function symbol is materialized with `IsAsync = true`. Less appealing because the symbol identity escapes into the bound tree before the rewrite, and we lose the early-error path for `yield`/`return` validation.

Shape 1 is preferred. The async re-interpretation is a property of *one* syntactic slot and should be resolved there.

### Symbol model

`SequenceTypeSymbol` currently materializes `IEnumerable<T>` eagerly. Two paths:

- **Parallel `AsyncSequenceTypeSymbol`** with `ClrType = IAsyncEnumerable<T>`, cached the same way. Cleanest separation; iterator rewriter and `IsAsyncIteratorReturnType` already key off the CLR type, so downstream passes need no changes. Recommended.
- **Flag on the existing type**: `SequenceTypeSymbol.Get(elementType, isAsync)` selecting between `IEnumerable<>` and `IAsyncEnumerable<>` at construction. Saves one class but couples two concepts into one symbol and risks accidental equality-by-element-type collisions.

### Implicit-async-iterator detection

Today `function.IsAsync = syntax.IsAsync || IsAsyncIteratorReturnType(type)` (Binder.cs:1128, 1135). Under this ADR, the implicit branch becomes redundant for the alias path because resolving `sequence[T]` to `IAsyncEnumerable[T]` requires `syntax.IsAsync` to already be true. The implicit branch still fires for the explicit `IAsyncEnumerable[T]` spelling, preserving today's behavior for direct BCL spellings.

### Validators that already work

- `IsIteratorReturnType` (Binder.cs:2794) accepts `SequenceTypeSymbol` *and* `IAsyncEnumerable[T]` via the CLR-type branch. If `sequence[T]` in an async function resolves to an `AsyncSequenceTypeSymbol` (or directly to `IAsyncEnumerable[T]`), `yield` is already accepted.
- `GetIteratorElementType` (Binder.cs:2857) already handles both shapes.
- `BindAwaitExpression` (Binder.cs:4924) already allows `await` whenever the enclosing function is async *or* returns an async iterator. Unchanged.
- `IteratorRewriter` and `AsyncIteratorRewriter` (test/Core.Tests/CodeAnalysis/Lowering/Iterators/) dispatch on CLR type; identical IL is produced for `sequence[int]` and `IAsyncEnumerable[int]` in an `async` context.

### Scope of the alias re-interpretation

The new rule applies **only** to the return-type clause of an `async func` (declaration, method, extension, lambda). Everywhere else — parameter types, local declarations, generic arguments, struct fields, `let x sequence[int]` *inside* an async function body — `sequence[T]` continues to mean `IEnumerable[T]`. This narrow scoping keeps the alias predictable: the only token that triggers the swap is the `async` modifier on the enclosing function, and the only affected slot is one fixed position.

### Migration

Purely additive. Existing code that spells `IAsyncEnumerable[T]` directly continues to work unchanged via `IsAsyncIteratorReturnType`. No existing program changes meaning, because there is no legal way today to write `async func foo() sequence[int]` and have it round-trip — the function would bind as `Task[IEnumerable[int]]` at call sites and `yield` would be rejected (no iterator return type). In other words, the proposed syntax is currently dead and the new rule fills the gap.

### Verdict

**Feasible.** The implementation cost is single-digit hours of binder work plus targeted unit tests. The architectural footprint is one new symbol class and one new branch in `BindTypeClause`. No emit, no lowering, no runtime changes.

## Decision

Adopt the context-sensitive alias rule:

> In the return-type clause of an `async func` (declaration, method, extension, or lambda), `sequence[T]` resolves to `System.Collections.Generic.IAsyncEnumerable<T>`. In every other position — including non-async functions, parameter types, local declarations, generic arguments, and type clauses inside an async function body — `sequence[T]` resolves to `System.Collections.Generic.IEnumerable<T>` as specified in ADR-0040.

Concretely:

```gsharp
async func foo() sequence[int] {   // sequence[int] == IAsyncEnumerable[int]
    yield 1
    await Task.Delay(10)
    yield 2
}

func bar() sequence[int] {         // sequence[int] == IEnumerable[int]
    yield 1
    yield 2
}

async func baz(items sequence[int]) sequence[int] {
    // parameter `items` is IEnumerable[int] (alias rule applies to return slot only)
    // return type is IAsyncEnumerable[int]
    for x in items { yield x }
}
```

The explicit spellings `IEnumerable[T]` and `IAsyncEnumerable[T]` remain legal everywhere and are unaffected.

## Consequences

Positive:

- Symmetric ergonomic surface for sync and async iterators; closes the open question in ADR-0040 §"Open questions" and the `asyncSequence[T]` follow-up in ADR-0023.
- One fewer keyword/alias to introduce; `asyncSequence[T]` is not needed.
- Reuses the precedent established by ADR-0022 (`<-` is async in async contexts) — context-sensitive lowering is already part of the language.
- No breaking change; the new syntax was previously inexpressible (would have produced `Task[IEnumerable[T]]` with no way to populate it via `yield`).

Negative:

- The same type-clause token denotes different CLR types depending on the enclosing function modifier. A casual reader must look at the function header to know what `sequence[T]` means here. Mitigation: documentation, hover tooling, and the scoping restriction (return-type slot only) keep the rule narrow.
- Hover/IDE tooling must thread the async context to render the correct CLR type in tooltips. Manageable: the symbol is materialized differently in each case, so hover follows the symbol.
- Diverges from C# (`IEnumerable<T>` and `IAsyncEnumerable<T>` are always distinct spellings) and Kotlin (`Sequence<T>` vs. `Flow<T>` are distinct names). GSharp has no Go analog because Go does not have iterators in this form.

Neutral:

- `IsAsyncIteratorReturnType` keeps detecting the explicit `IAsyncEnumerable[T]` spelling, so the implicit-async-iterator path (no `async` modifier, return type alone implies async) remains usable for the explicit BCL spelling but is *not* triggered by `sequence[T]`. To get an async iterator via the alias, the `async` modifier is mandatory. This is intentional: it keeps the alias unambiguous at the call site (a reader sees `async` and knows the swap is in play).
- A function `func foo() sequence[int]` cannot be implicitly promoted to an async iterator. Users wanting an async iterator must either add `async` (alias swap fires) or spell `IAsyncEnumerable[int]` directly.

## Implementation summary

Shipped as a small, additive binder change:

1. New `AsyncSequenceTypeSymbol` (`src/Core/CodeAnalysis/Symbols/AsyncSequenceTypeSymbol.cs`) mirrors `SequenceTypeSymbol` but materializes `ClrType = IAsyncEnumerable<T>`, cached per element type.
2. New `Binder.BindReturnTypeClause(TypeClauseSyntax, bool isAsync)` helper. When `isAsync` is `true`, it post-processes a top-level `SequenceTypeSymbol` (optionally wrapped in `NullableTypeSymbol`) into `AsyncSequenceTypeSymbol`. All four return-type binding sites — free/extension/method function declarations, class methods, interface methods, and lambdas — now route through this helper.
3. No changes needed in downstream passes. `IsAsyncIteratorReturnType` (binder), `IteratorRewriter.IsAsyncIteratorFunction`, and `AsyncIteratorRewriter.IsAsyncIteratorFunction` all key off the CLR type (`IAsyncEnumerable\`1`), so an `AsyncSequenceTypeSymbol` is routed to the async-iterator state-machine path automatically.
4. End-to-end tests live in `test/Core.Tests/CodeAnalysis/Emit/AsyncSequenceAliasTests.cs` and cover: yield-only, mixed yield + await, CLR-shape verification (`IAsyncEnumerable<int>` and not `IEnumerable<int>`), sync behavior preservation when `async` is absent, parameter-position non-swap inside an async function body, and equivalence of the alias and the explicit `IAsyncEnumerable[int]` spelling.

The change is purely additive: existing code spelling `IAsyncEnumerable[T]` directly continues to work, and existing sync `sequence[T]` programs are unaffected.

## Alternatives considered

### A. Introduce a separate `asyncSequence[T]` keyword

This is the path implied by the ADR-0023 and ADR-0040 follow-ups. It mirrors Kotlin's `Sequence<T>` / `Flow<T>` and C#'s separate spellings. Pros: zero ambiguity, no context-sensitive resolution rule. Cons: a second contextual keyword for a concept that the `async` modifier already disambiguates, and asymmetry of *naming* (`asyncSequence` reads heavier than `sequence`). Rejected in favor of the unified spelling but kept as a fallback if the context-sensitive rule proves confusing in practice.

### B. Resolve `sequence[T]` to `IAsyncEnumerable[T]` everywhere inside an async function body

Considered and rejected. Treating parameter types and local declarations as async-aliased would surprise readers, break the principle that a type clause's meaning is determined locally, and make it impossible to declare a synchronous `IEnumerable[int]` parameter inside an async function. The chosen scope — return-type slot only — keeps the rule predictable and one-keyword-deep.

### C. Make `async` mandatory on any function returning `IAsyncEnumerable[T]`

Considered and rejected as overreach. The implicit-async-iterator detection in ADR-0023 (`IsAsync = ... || IsAsyncIteratorReturnType(type)`) is already shipped and lets users omit `async` when the BCL spelling makes the intent obvious. This ADR does not change that rule for the explicit spelling; it only adds the alias-driven path that *requires* `async` because the alias is the only signal.

### D. Defer indefinitely; leave users to spell `IAsyncEnumerable[T]`

The status quo. Rejected because the asymmetry between sync and async iterator ergonomics is a documented open question in two shipped ADRs, and the implementation cost of this proposal is small.

## Implementation sketch (informative, not normative)

The bullets below describe the change as proposed; see "Implementation summary" above for what actually shipped.

1. Introduce `AsyncSequenceTypeSymbol` mirroring `SequenceTypeSymbol` but with `ClrType = typeof(IAsyncEnumerable<>).MakeGenericType(elementType.ClrType)`, cached by element type.
2. In `Binder.BindFunctionDeclaration` (and the lambda counterpart), pass an `inAsyncReturnSlot` flag when binding the *return* type clause. When `BindTypeClause` sees `syntax.IsSequence && inAsyncReturnSlot`, construct `AsyncSequenceTypeSymbol.Get(elementType)` instead.
3. Extend `IsIteratorReturnType` and `GetIteratorElementType` to recognize `AsyncSequenceTypeSymbol` (mirroring the existing `SequenceTypeSymbol` branches). All downstream passes already handle `IAsyncEnumerable[T]` by CLR type and need no further changes.
4. Add binder unit tests covering: async lambda return type, async method on a struct, async extension function, alias-vs-explicit interoperability, parameter-position `sequence[T]` inside an async function (must stay sync), and a `func foo() sequence[int]` without `async` (must stay sync).
5. Add an end-to-end emit test mirroring `AsyncIteratorEmitTests.numbers` but using `async func numbers() sequence[int]` to verify the produced state-machine class implements `IAsyncEnumerable<int>`.
6. Update ADR-0040 §"Open questions" item 1 to point at this ADR; update ADR-0023 §"Known limitations" `asyncSequence[T]` line to mark the alias question resolved here.
