# ADR-0106: Incremental LSP SemanticModel via instance-keyed memoization

- **Status**: Proposed
- **Date**: 2026-06-15
- **Phase**: Language-server performance
- **Related**: issue #869; ADR-0105 (incremental delta binding — the layer below); issue #866; `src/LanguageServer/SemanticLookup.cs`, `src/LanguageServer/ProjectState.cs`, `src/Core/CodeAnalysis/Binding/BoundBodyCache.cs`

## Context

ADR-0105 made the compiler's *bind* phase (`GlobalScope` + `BoundProgram`) incremental: on a single-file body-only edit the language server reuses the previous `BoundGlobalScope` and re-binds only the edited body. But per-keystroke completion/hover/definition latency on large multi-file projects is still ~0.5–1 s on a genuine edit, because a second whole-project pass sits on top of binding: building the LSP `SemanticModel`.

### Where the time goes (issue #869, Oahu `Oahu.Cli.Tests`, 54 files, 352 refs)

Driving the real path (`ProjectDiscovery` → `ProjectState` → `CompletionComputer.ComputeCompletions`), a true in-body keystroke decomposes as:

```
parse ~0.5 ms | bind (GlobalScope+BoundProgram) ~330–520 ms | SemanticModel build ~250–400 ms | warm completion ~5 ms
```

| | Cold (fresh `Compilation`, model rebuilt) | Warm (same `Compilation` reused) |
| --- | --- | --- |
| `Assert.` completion | ~550 ms | ~5 ms |
| `bb.MfaCalls.` completion | ~550 ms | ~4 ms |

The ~250–400 ms `SemanticModel` slice is the subject of this ADR. (The binding slice is ADR-0105's domain; broadening its fast path is a separate #869 follow-up.)

### Why the model rebuilds fully every edit

`SemanticLookup` caches one `SemanticModel` per `Compilation` in a `ConditionalWeakTable<Compilation, SemanticModel>` (`ModelCache`). Every edit produces a *new* `Compilation`, so the table misses and `BuildModelUncached` runs from scratch: it walks `compilation.GlobalScope` and **every** `SyntaxTree`, collecting per-token declaration maps (`declarations`, `declarationsBySpan`), the `globals` name→symbol map, and per-function local maps (`localDeclarations`) by matching each `BoundBlockStatement`'s locals back to their declaring syntax. The cost scales with workspace size, not edit size. This is the "model build adds several hundred ms" cost called out in #866, and completion, hover, definition, and references all pay it.

### The structural opportunity

The two dominant costs in `BuildModelUncached` are both **pure functions of an instance that survives an edit unchanged**:

1. **Per-tree syntax-node collection** — gathering the declarations, references, `for`/`await-for` ranges, variable declarations, and type-alias nodes out of a file — is a pure function of that file's `SyntaxTree` instance. `ProjectState.UpdateFile` only replaces the *edited* file's tree; every unchanged file keeps its exact `SyntaxTree` instance across the edit.

2. **Per-body local matching** — pairing a function's bound locals to their declaring identifier tokens — is a pure function of the lowered `BoundBlockStatement` instance. ADR-0105's `BoundBodyCache.TryReuse` returns the **same** `BoundBlockStatement` instance for any body it deems unchanged (`ReferenceEquals(entry.Member, member)`), so unchanged bodies present an identical instance to the model builder.

Because both inputs are instance-stable, memoizing on instance identity turns "re-walk all 54 files" into "re-walk only the edited file" — without threading the previous model, diffing files, or mutating the immutable `Compilation`.

## Decision

Memoize the two dominant per-edit costs in `SemanticLookup` on **instance identity**, using static `ConditionalWeakTable`s:

- `NodeBucketCache: ConditionalWeakTable<SyntaxTree, NodeBuckets>` — the collected syntax nodes for a tree (declarations, references, `for`/`await-for` ranges, variable declarations, type-alias declarations). Keyed by `SyntaxTree` instance.
- `FunctionLocalsCache: ConditionalWeakTable<BoundBlockStatement, IReadOnlyList<(SyntaxToken Identifier, Symbol Variable)>>` — the (identifier → local symbol) pairs for one function body. Keyed by `BoundBlockStatement` instance.

`BuildModelUncached` now:

1. Computes `bucketsByTree` once via `GetNodeBuckets(tree)`, which consults `NodeBucketCache` (hit for unchanged files, miss → `CollectNodes` for the edited file). The global-variable and type-alias passes iterate these cached buckets instead of re-scanning the whole project.
2. Builds each function's local map via `GetFunctionLocals(decl, boundBody)`, which consults `FunctionLocalsCache` keyed by the bound body instance (hit for unchanged bodies, miss → `ComputeFunctionLocals`/`MatchBoundLocals`), then replays the cached pairs into `declarations`/`localDeclarations`.
3. Constructs the `SemanticModel` from the supplied `bucketsByTree` rather than re-collecting nodes itself.

Because the cache keys are instances and the cached values are pure functions of those instances, the memoized build is **identical by construction** to a from-scratch build of the *same* `Compilation` — there is no separate "previous model" whose staleness must be reasoned about. `globals` is derived from the (reused) `GlobalScope` symbols and is recomputed cheaply on each build.

This deliberately departs from #869's literal suggestion (thread the previous `SemanticModel` and replace per-file buckets, keyed off ADR-0105's `ReusedGlobalScope`/`DirtyBodyTrees` signal). Instance-keyed memoization is strictly more robust: it needs no fast-path signal, keeps `Compilation` immutable-per-instance, and *also* accelerates full-rebuild fallbacks (unchanged trees still hit the per-tree memo even when the global scope is re-bound).

### Equivalence (the non-negotiable correctness property)

The `SemanticModel` is an LSP-only artifact; it does not affect emitted IL. "Correctness" therefore means **the incremental model produces results identical to a full `BuildModelUncached`**. This holds by construction: memoization only substitutes a cached value for a recomputation of the *same pure function on the same instance*. To make this testable, `BuildModelForTest(compilation, useIncrementalCaches)` exposes a build with memo caches either consulted (`true`) or bypassed (`false`). The oracle is the bypassed build of the *same edited compilation*; both operate over the same reused `GlobalScope`/symbols, so any divergence would be a memoization bug, which the tests would catch.

ADR-0106 ships `IncrementalSemanticModelTests` asserting, after a body-only edit, that the incremental and full builds agree on:

- `Resolve` for **every** identifier token of **every** file (same `Symbol` instance),
- `GetLocals` for **every** `FunctionDeclarationSyntax`, and
- the `globals` map (same keys, same symbol instances).

Plus: a signature edit and a multi-file edit fall back to full rebuild and stay equivalent; a counter-based test proves the body-only path actually reuses unchanged files (≥ 3 of 4 trees served from `NodeBucketCache`, the edited tree recomputed, unchanged bodies served from `FunctionLocalsCache`); and cross-file references resolve correctly after a body-only edit.

### What takes the incremental path vs. full fallback

There is no explicit branch on edit shape. *Every* build consults the memo caches; the **inputs decide**:

- **Body-only edit (ADR-0105 fast path engaged)** — unchanged files keep their `SyntaxTree` instance (per-tree memo hit) and `BoundBodyCache` returns the same `BoundBlockStatement` instance for unchanged bodies (per-body memo hit). Only the edited file recomputes. This is the dominant editing case and the primary win.
- **Signature edit / multi-file edit / any full re-bind** — the `GlobalScope` and `BoundProgram` are rebuilt, so every body is a *new* `BoundBlockStatement` instance ⇒ all per-body memos miss and recompute (no staleness). But unchanged files still keep their `SyntaxTree` instance, so the per-tree node collection is *still* reused. Over-work is always safe; the result is identical to a from-scratch build regardless.

## Consequences

**Positive**

- The per-edit model build drops from whole-project to single-file work on the common body-only edit, removing the ~250–400 ms model-build slice from cold completion/hover/definition on large projects. The win applies uniformly to completion, hover, and definition (everything on the `Resolve`/`GetLocals` path).
- The acceleration is *broader* than ADR-0105's fast path: even when binding falls back to a full re-bind (e.g. files with `init()`, which #869 notes are common in test code), the per-tree node-collection memo still spares re-walking unchanged files.
- No change to `Compilation` shape, no new mutable state on it, no "previous model" plumbing; the design composes cleanly with the existing `ConditionalWeakTable<Compilation, SemanticModel>` cache.

**Negative / neutral**

- Two additional process-lifetime `ConditionalWeakTable`s. Entries are GC-collected once their key `SyntaxTree` / `BoundBlockStatement` is unreachable (i.e. when the owning `Compilation` is dropped), so steady-state memory tracks live syntax/bound state rather than growing unbounded.
- The static cache hit/miss counters used by the reuse test are process-global; the ADR-0106 tests live in one collection and use `>=` assertions so parallel test classes cannot make them flaky.
- **The lazy references index is not yet incremental.** `SemanticModel.BuildReferencesIndex` still re-resolves all tokens on the first `FindReferences`/CodeLens after each edit. References therefore still pay a whole-project pass on first use. This is a deliberately deferred follow-up (see below); the primary completion/hover/definition path does not touch it.

## Alternatives considered

- **Thread the previous `SemanticModel` and swap per-file buckets (issue #869's literal proposal).** Requires a previous-model pointer (on `Compilation` or via `ProjectState`) gated on ADR-0105's `ReusedGlobalScope` signal, plus reasoning about which buckets are stale. Rejected: more moving parts, pressures `Compilation`'s immutability, only helps when the fast-path signal is present, and makes equivalence harder to argue than pure instance-keyed memoization (which is identical-by-construction and also speeds up fallbacks).
- **Key the whole model on a content hash instead of the `Compilation` instance.** Would let byte-identical edits share a model, but does nothing for genuinely-new text (the actual cost in #869) and risks subtle hash-collision correctness bugs. The existing instance-keyed `ModelCache` already handles the byte-identical case (that is the "warm ~5 ms" column).
- **Make the references index incremental in the same change.** Valuable but larger, and it is off the hot completion/hover/definition path. Deferred to keep this change focused and its equivalence argument tight.

## Follow-ups

- Make `BuildReferencesIndex` incremental (per-file reference buckets keyed by `SyntaxTree`), so first-use FindReferences/CodeLens after an edit also avoids a whole-project pass.
- Broaden ADR-0105 Phase 2's supported-construct surface (re-point constructors / computed-property & event accessors) so files with `init()` etc. also get incremental *binding*, compounding with this model win.
