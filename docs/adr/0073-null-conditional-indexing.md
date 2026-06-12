# ADR-0073: `a?[i]` null-conditional indexing

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 9 — language depth / null-handling ergonomics
- **Related**: ADR-0001 (nullable reference types), ADR-0054 (postfix member access on primary expressions), the existing `?.` null-conditional member access, parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#710](https://github.com/DavidObando/gsharp/issues/710)

## Context

G# already has `?.` for null-conditional **member** access (introduced with
the original nullable-reference-types work, ADR-0001 / Phase 3.C.3b). The
read form short-circuits when the receiver is nil and lifts the result to
the nullable form of the member's type. The receiver is evaluated exactly
once (captured into a synthetic local) so chains such as `getBox()?.Name`
are well-defined even when the receiver has side effects.

The parallel null-conditional **indexing** form has been missing. Today
programmers have to write the long-hand:

```gs
var hit int32? = nil
if d != nil {
    hit = d["k"]
}
```

…which is verbose and re-introduces all the foot-guns of explicit
nil-checks (forgetting the guard, re-evaluating the receiver twice, racing
between read and re-check). C#, Kotlin, Swift, TypeScript and modern Dart
all converged on the same surface syntax — `a?[i]` — for exactly this
case, with semantics that mirror `a?.member`.

## Decision

Add `a?[i]` as a **read-only** postfix operator with these semantics:

1. **Receiver-evaluated-once.** `a` is evaluated exactly once. If the value
   reads as nil, the whole expression is nil and the **index sub-expression
   is NOT evaluated**. Otherwise the indexed access fires against the
   captured value.
2. **Lifting rules.** The result type is the nullable form of the indexer's
   element type:
   - `T → T?` (always lift; matches the bound result type produced for
     `?.` member access).
   - `T? → T?` (unchanged — already lifted, no double-wrap).
3. **Composes with `?.` / `?[]` chains.** A chain such as
   `a?.b?[i]?.c` short-circuits at the leftmost nil-producing segment:
   if `a` is nil, the whole chain is nil; if `a.b` is nil, the chain is
   nil; if `a.b[i]` returns nil, the rest of the chain is nil; otherwise
   the chain produces `(a.b[i]).c` lifted to nullable. Each receiver in
   the chain is captured into its own synthetic local, so every
   side-effecting expression on the left of a `?.` or `?[]` is evaluated
   at most once.
4. **Backends.** Both the IL emit path and the interpreter (`Evaluator`)
   honor the rewrite — the new form reuses
   `BoundNullConditionalAccessExpression`, so no new bound node is added
   and no new code is needed in the slot planner, spill spiller, tree
   walker, or tree rewriter beyond what already supported `?.`.
5. **Applies to every indexable shape.**
   - G# arrays (`[N]T`).
   - G# slices (`[]T`).
   - G# maps (`map[K]V`).
   - CLR indexers on imported reference types (e.g. `Dictionary[K, V]`).
   - User-defined struct/class indexers (via the same CLR indexer path).
6. **Assignment LHS is rejected.** `a?[i] = v`, `a?[i] += v`, and
   `a?[i] ??= v` all produce a binder diagnostic. This matches C#'s
   CS0131 behavior on `?[]` LHS — the author who wants "assign-if-not-nil"
   should write the explicit guard (`if a != nil { a[i] = v }`) so the
   intent is unambiguous. (Allowing the LHS form would conflate
   "write when alive" with "silently no-op when nil", which has been a
   recurring source of bugs in languages that do allow it.)
7. **Non-nullable receiver yields a warning.** A `?[...]` over a
   non-nullable receiver is dead code on its null-check arm. The binder
   reports `GS0300` (warning, *not* error) suggesting the plain `[...]`
   form. The expression is still bound — the result type is still lifted
   to the nullable form — so adding `?` for defensive consistency in
   generic code that may later widen to nullable doesn't break the build.

### Diagnostics introduced

- `GS0300` (warning) — receiver of `?[...]` is non-nullable; use `[...]`.
- `GS0301` (error) — `?[...]` cannot appear on the left-hand side of an
  assignment.

### Lexer / token

A new token kind `QuestionOpenBracketToken` (`?[`) is produced **only when
`?` is immediately followed by `[` with no intervening trivia**. This
matches the convention used for `?.` (single token `QuestionDotToken`) and
ensures the existing ternary form `cond ? [arr] : [arr]` (where whitespace
separates the `?` from the `[`) keeps lexing as two tokens.

## Lowering

The binder rewrites `a?[i]` as a `BoundNullConditionalAccessExpression`
whose `Receiver` is `a`, whose `Capture` is a fresh synthetic local of
the underlying (non-nullable) type of `a`, and whose `WhenNotNull` is the
ordinary bound index access against the capture
(`BoundIndexExpression` or `BoundClrIndexExpression`). The existing
emit / evaluator handling of `BoundNullConditionalAccessExpression`
(branching on capture-is-null, materializing `default(Nullable<T>)` for
value-typed results, leaving `ldnull` on the stack for reference-typed
results) covers the new form without further changes.

Pseudocode for the rewrite of `a?[i]`:

```
tmp = a
if tmp == nil { result = nil }
else          { result = tmp[i] }   // lifted to T?
```

For chained `a?.b?[i]?.c`, each `?.` / `?[]` introduces its own capture
and its own null-check, with the not-null branch of the outer wrap
flowing into the receiver of the inner wrap — exactly as for
`a?.b?.c?.d` today.

## Consequences

- One new token, one new diagnostic family, and one new
  `IndexExpressionSyntax.IsNullConditional` flag — but **no new bound
  node**, so the emit / planner / spill / rewriter / walker / printer
  surfaces only need additive changes to the existing `?.` paths.
- Brings G# to parity with C# on null-conditional ergonomics for
  collections and CLR indexers.
- The rejection of `?[...]` as an assignment LHS is opinionated: a future
  ADR could re-open this if a compelling use case emerges, but the
  current consensus (mirroring C#) is that explicit guards are clearer.

## Alternatives considered

- **Allow `a?[i] = v` as a silent no-op when `a` is nil.** Rejected:
  matches Kotlin's `?.set(...)` behavior but conflates two intents —
  "assign when alive" and "silently skip" — which has been a source of
  hard-to-diagnose bugs in real codebases.
- **Tokenize `?[` lazily at the parser layer** (peek `?` + `[`). Rejected
  for consistency with `?.`, `?:`, `??=` which are all single tokens.
  Single-token form also makes the lexical structure self-documenting in
  `SyntaxFacts.GetText`.
- **Reuse the existing `?.` token by re-parsing the access RHS as an
  index.** Rejected: `a?.[i]` is not a valid surface form (no member name),
  and we'd lose the ability to distinguish `?.` from `?[]` at the syntax
  layer for tooling.

## References

- Parent control-flow polish epic: [#706](https://github.com/DavidObando/gsharp/issues/706)
- This change: [#710](https://github.com/DavidObando/gsharp/issues/710)
- C# null-conditional indexing (CS0131 on LHS): <https://learn.microsoft.com/dotnet/csharp/language-reference/operators/member-access-operators#null-conditional-operators--and->
