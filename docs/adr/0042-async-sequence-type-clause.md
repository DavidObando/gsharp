# ADR-0042: `async sequence[T]` as a type-clause spelling for `IAsyncEnumerable[T]`

- **Status**: Accepted
- **Date**: 2026-05-25
- **Phase**: Phase 7 follow-up — iterator ergonomics
- **Related**: ADR-0023 (async state machine), ADR-0040 (`sequence[T]` + `yield`), ADR-0041 (`sequence[T]` aliases `IAsyncEnumerable[T]` in async return slot), issue #150 (`async func(P) R` as a function-type clause)

## Context

ADR-0040 introduced `sequence[T]` as a contextual-keyword alias for `IEnumerable<T>`. ADR-0041 made `sequence[T]` resolve to `IAsyncEnumerable<T>` *only* in the return-type slot of an `async func`. That covers the common producer case but leaves a gap: there is no GSharp-flavored spelling for `IAsyncEnumerable[T]` in any other type-clause position. Users must drop to the BCL spelling everywhere else:

```gsharp
// Today (post-ADR-0041)
async func gen() sequence[int] { yield 1 }      // OK — alias swap
func consume(s IAsyncEnumerable[int]) { ... }   // BCL spelling required
let stream IAsyncEnumerable[int] = gen()        // BCL spelling required
data Pipeline { items IAsyncEnumerable[int] }   // BCL spelling required
```

The asymmetry is visible at every consumer site. This ADR closes the gap by extending the `async` modifier — already used on function declarations and lambdas — into a *type-clause prefix* that may appear before `sequence[T]`.

The grammar admits this cleanly because `async` is already a hard keyword (`SyntaxFacts.GetKeywordKind` maps `"async"` unconditionally to `AsyncKeyword`), so it is not a legal identifier or type name in any existing program. Adding `async` to the type-clause-start set introduces no parsing ambiguity and no breaking change.

## Decision

In any type-clause position, `async sequence[T]` is a spelling for `System.Collections.Generic.IAsyncEnumerable<T>`. The two-token form is the only legal use of `async` as a type-clause prefix in this slice; `async X` for any other `X` is a parse-time error (with one carved-out exception under design in issue #150 for `async func(P) R`).

Concretely:

```gsharp
// Parameter
func consume(stream async sequence[int]) { await for x in stream { ... } }

// Local
let stream async sequence[int] = gen()

// Struct/class field
data Pipeline { items async sequence[int] }

// Generic argument
let cbs List[async sequence[int]] = ...

// Tuple element
let pair (string, async sequence[int]) = ("a", gen())

// Function-type clause (return slot)
let factory func() async sequence[int] = gen

// Pointer pointee, map value, chan element, nullable wrap
let opt async sequence[int]? = nil
let m map[string,async sequence[int]]
```

All of the above resolve to the same `AsyncSequenceTypeSymbol` and therefore the same CLR type as the explicit `IAsyncEnumerable[T]` spelling and the ADR-0041 implicit-swap form.

### Interaction with ADR-0041

After this ADR, an async iterator's return type may be spelled three equivalent ways:

```gsharp
async func a() sequence[int] { ... }              // ADR-0041 implicit swap
async func b() async sequence[int] { ... }        // explicit modifier form
async func c() IAsyncEnumerable[int] { ... }      // BCL spelling
```

All three produce identical IL and identical symbols. The implicit swap remains the recommended common-case spelling because the `async` modifier is already on the function header; the explicit modifier form is available for users who prefer maximum local clarity in long signatures or in non-return positions; the BCL spelling is always available for interop documentation.

### Restriction: `async` is only valid before `sequence` in type-clause position

`async` as a type-clause prefix is reserved for the iterator alias. `async map[K,V]`, `async chan T`, `async []T`, `async *T`, etc. are explicitly rejected with a diagnostic. Generalizing the modifier to function-type clauses (`async func(P) R` ≡ `func(P) Task[R]`) is the subject of ADR-0043; this ADR leaves the door open without committing.

## Consequences

Positive:

- Closes the asymmetry between sync and async iterator type-clause spellings everywhere a type may appear.
- Single grammar rule, single binder branch, zero downstream changes — all consumer sites (`await for`, iterator rewriter, async-iterator rewriter, emit) already key off the CLR type produced by `AsyncSequenceTypeSymbol` (shipped with ADR-0041).
- Reuses the existing `async` keyword; no new reserved word; reads consistently with `async func` declarations and lambdas.
- Future-proofs the modifier for ADR-0043 (`async func(P) R`).

Negative:

- Introduces a *two-token* type-clause shape (`async sequence[T]`) — a small departure from GSharp's existing single-prefix type forms (`*T`, `[]T`, `chan T`, `sequence[T]`, `map[K,V]`). Mitigation: the parallel with `async func` makes the shape immediately recognizable.
- Three legal spellings exist for the same async-iterator return type. Style guidance picks one canonical form; the language remains permissive.

Neutral:

- `asyncSequence[T]` as a single-token keyword (mentioned as an open question in ADR-0040 §"Open questions") is foreclosed by this ADR. The two-token modifier form strictly dominates it: no new reserved word, parallels `async func`, reads naturally with nullable and generic positions.
- Tooling hover currently renders `AsyncSequenceTypeSymbol.Name` as `"sequence[T]"`. Polishing the hover to render `"async sequence[T]"` or the BCL spelling when the source used the explicit modifier form is a nice-to-have; the symbol identity is unchanged either way.

## Alternatives considered

### A. Introduce a single-token `asyncSequence[T]` keyword

The path implied by the ADR-0040 §"Open questions" entry. Rejected: requires a new reserved word, reads less naturally than the modifier form in nullable and generic positions (`asyncSequence[int]?` vs `async sequence[int]?`), and does not generalize to other possible `async` type forms.

### B. Restrict `async sequence[T]` to a subset of type-clause positions (e.g. only locals and parameters)

Rejected: the grammar change (single parser branch) is the same regardless of how many positions accept it, and restricting the alias surface would re-introduce the very asymmetry this ADR closes.

### C. Defer indefinitely

The status quo after ADR-0041. Rejected: the parameter/local/field asymmetry is visible in every consumer-side declaration and the implementation cost is small.

### D. Generalize `async` to all type-clause prefixes in this ADR (`async map[K,V]`, `async chan T`, etc.)

Rejected as overreach. None of the other forms have an existing BCL counterpart, and conflating the modifier across unrelated shapes would erode its meaning. Function-type clauses (`async func(P) R`) are tracked separately in ADR-0043.

## Implementation summary

Shipped in this PR as a strictly additive change. No existing program changes meaning; no existing test changes behavior.

1. **Parser** (`src/Core/CodeAnalysis/Syntax/Parser.cs`):
   - `ParseTypeClause` gains a leading branch on `AsyncKeyword`. It consumes `async`, then requires the next token to be `sequence` (reporting a clean diagnostic otherwise), then delegates to the existing sequence-type-clause path tagged with an `IsAsync` flag.
   - `ParseOptionalTypeClause`'s type-clause-start whitelist gains `AsyncKeyword`.
2. **Syntax model** (`src/Core/CodeAnalysis/Syntax/TypeClauseSyntax.cs`): the existing sequence type-clause shape carries a new optional `AsyncModifier` token. `IsAsyncSequence` returns true when the modifier is present.
3. **Binder** (`src/Core/CodeAnalysis/Binding/Binder.cs`): the `IsSequence` branch in `BindNonNullableTypeClause` constructs `AsyncSequenceTypeSymbol.Get(elementType)` when `syntax.IsAsyncSequence` is true, and `SequenceTypeSymbol.Get(elementType)` otherwise. ADR-0041's `BindReturnTypeClause` swap path continues to apply to the unmodified sync alias; it does not need to fire for the explicit modifier form because the binder already produces the async symbol directly.
4. **Diagnostics**: new "the `async` modifier in a type clause is only valid before `sequence[T]`" diagnostic emitted by the parser when `async` is followed by any token other than `sequence`.

No changes to lowering, emit, iterator rewriters, await-for binding, or any symbol code outside `AsyncSequenceTypeSymbol` (introduced in ADR-0041 / PR #149).
