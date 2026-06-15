# ADR-0105: Incremental (delta) binding for the language server

- **Status**: Proposed
- **Date**: 2026-06-15
- **Phase**: Language-server performance
- **Related**: issue #866; issue #868 (cross-session cold-start cache — complementary); ADR-0002 (concurrency model); `src/LanguageServer/ProjectState.cs`, `src/Core/CodeAnalysis/Compilation/Compilation.cs`, `src/Core/CodeAnalysis/Binding/Binder.cs`

## Context

On large multi-file G# projects the language server's per-keystroke latency for completion, diagnostics, and the first model-dependent request after an edit is dominated by a **full-program re-bind**. Every edit produces a fresh `Compilation` whose `GlobalScope` and `BoundProgram` are bound from scratch across *all* files, even when only one file — often only one method body — changed. The cost scales with workspace size, not edit size.

### How the re-bind happens today

`ProjectState.GetCompilation()` is the single funnel every LSP feature goes through. On each edit `ProjectState.UpdateFile` re-parses the changed file and calls `Invalidate()`; the next `GetCompilation()` constructs a brand-new `new Compilation(resolver, trees)` with **no `Previous` chain**:

```csharp
// src/LanguageServer/ProjectState.cs (GetCompilation, simplified)
var trees = syntaxTrees.Values.ToArray();
compilation = new Compilation(resolver, trees);   // Previous == null
```

A fresh `Compilation` has empty lazy caches, so the first access re-binds everything:

- `Compilation.GlobalScope` → `Binder.BindGlobalScope(Previous?.GlobalScope == null, allTrees, ...)` — re-resolves every package, import, type alias, delegate, interface, enum, struct, and function *signature* across all files.
- `Compilation.BoundProgram` → `Binder.BindProgram(GlobalScope, ...)` — re-binds and lowers **every** method/function body, walking `globalScope.Functions`, every `struct.Methods`, property/event accessors, constructors, and top-level statements.

### Measured cost (Oahu, `Oahu.Cli.Tests`, 54 source files, 352 assembly references)

Numbers captured on the local repro workspace `~/GitHub/DavidObando/Oahu` by driving the real LSP path (`ProjectDiscovery` → `ProjectState` → `Compilation.GlobalScope` / `BoundProgram`), median of 7 keystroke iterations, two runs:

| Phase | `GlobalScope` | `BoundProgram` | Total |
| --- | --- | --- | --- |
| Cold (first compilation, includes metadata load of 352 refs) | ~290–336 ms | ~594–602 ms | ~880–940 ms |
| Steady-state keystroke (one file changed → fresh `Compilation`) | ~12–15 ms | ~360–390 ms | ~372–403 ms |

Two things stand out:

1. **The per-keystroke cost is dominated by `BoundProgram` (~360–390 ms): re-binding every body.** That is the architectural ceiling the LSP layer cannot push past with constant-factor work.
2. **Warm `GlobalScope` is already cheap (~12–15 ms).** The expensive part of cold `GlobalScope` is one-time CLR metadata loading, which `ReferenceResolver` already caches across compilations (it survives in `ProjectState.cachedResolver`). So signature re-binding itself is not the bottleneck on a warm session — *body* re-binding is.

On top of these binder numbers the LSP `SemanticModel` build (`SemanticLookup.BuildModelUncached`) and reference-index build add their own per-edit cost, but those are keyed on the `Compilation` instance and invalidate naturally when the compilation is replaced; they are out of scope here.

### Why the binder is well-shaped for delta binding

The expensive part is also the most cacheable part:

- `Binder.BindProgram` binds **each body independently** from `parentScope`: `new Binder(parentScope, function); binder.statements.BindStatement(function.Declaration.Body)`. A bound body is effectively a pure function of `(GlobalScope, body syntax)`. That is exactly the shape needed for per-method caching and reuse.
- `Compilation.GlobalScope` and `BoundProgram` are already lazy and cached per instance (guarded by `Interlocked.CompareExchange`).
- Lowering is already body-local for synthesized names: `Lowerer.Lower` constructs a **fresh `Lowerer` per body**, and the `Label{n}` counter (`labelCount`) is an instance field. Synthesized label names therefore depend only on a body's own shape, not on sibling bodies or binding order.

The gap is identity. `BindProgram` keys bodies by `FunctionSymbol`, and every new `Compilation` constructs **fresh symbol instances**. A body cache keyed on the symbol instance would never hit across edits, and a bound body from compilation *N* references *N*'s symbols, so it cannot be spliced into compilation *N+1* without those symbols also being reused.

## Decision

Adopt a **two-phase delta-binding architecture**, designed here and implemented in follow-up work. This ADR fixes the design contract — stable identity, invalidation, determinism, and where the cache lives — so the phases can land incrementally without re-litigating the architecture.

### Phase 1 — Incremental body binding

Cache each lowered `BoundBlockStatement` keyed by a **stable function identity plus body content**, conceptually `(stableMemberId, bodyHash)`:

- `stableMemberId` is a position-independent identity for the member: e.g. `(sourceFilePath, containing-type path, member name, parameter-type signature)`. It must *not* depend on a symbol object reference, a `SyntaxNode` reference, or a source span (spans shift when earlier text changes).
- `bodyHash` is a content hash of the member's body syntax (and anything else its binding depends on beyond `GlobalScope` — see invalidation).

On a re-bind, `BindProgram` looks up each member: if `stableMemberId` is unchanged and `bodyHash` matches, **reuse the cached lowered body** instead of re-binding and re-lowering. A single-file edit then re-binds only the bodies in that file (and any whose binding depended on changed signatures — see Phase 2). Determinism is preserved because the cached body is byte-for-byte the one a from-scratch bind would have produced (body-local label counters; no cross-body state).

Phase 1 is *correct in isolation but rarely hits* until Phase 2 lands, because reused bodies reference symbols from `GlobalScope`. That is the explicit motivation for Phase 2.

### Phase 2 — Incremental `GlobalScope` via per-file symbol tables

Make `GlobalScope` composable from **per-file declaration tables** that carry **stable symbol identity**:

- Each source file binds its own declarations (signatures only) into a per-file table. `GlobalScope` is the composition of those tables plus references.
- When a file is edited, only that file's table is rebound. **If the file's *signatures* are unchanged** (body-only edit), its symbols are **reused by identity** — the same `FunctionSymbol`/`StructSymbol`/… instances flow into the new `GlobalScope`. This is what makes Phase 1's cache hit on the common case (typing inside a method body).
- **If a file's signatures changed**, that file's symbols are rebuilt, and any *dependent* files (those whose binding referenced the changed symbols) are invalidated transitively.

The existing `Compilation.Previous` chain is **not** the vehicle for this: it is append-only / REPL-oriented (each link *adds* trees; `BindGlobalScope` walks `previous.Functions` cumulatively). Delta binding needs *replace-one-file* semantics, which the append-only chain cannot express. Phase 2 therefore introduces per-file tables as a first-class concept rather than overloading `Previous`.

### Stable symbol identity

Phase 1 and Phase 2 both depend on symbols having an identity that survives across compilations:

- A symbol's identity is its `stableMemberId` (file + type path + name + signature), independent of object reference and source span.
- When a file is rebound and a declaration's signature is byte-identical, the binder **reuses the prior symbol instance** for that identity rather than allocating a new one.
- Equality/hashing on cache keys uses `stableMemberId`, never `ReferenceEquals` on symbols or `SyntaxNode`s.

This is the load-bearing invariant. Without it, "reuse" silently degrades to "re-bind," and reused bodies would reference stale symbols (a correctness bug, not just a perf miss).

### Cache invalidation rules

Define invalidation precisely; over-invalidation costs performance, under-invalidation is a correctness bug:

- **Body-only edit** (signatures of all members in the file unchanged): rebind only that file's bodies; reuse that file's *symbols* and all *other files'* bodies and symbols.
- **Signature edit** in a file (parameter/return/field/type changes, new/removed/renamed member): rebuild that file's symbol table; invalidate and rebind the bodies of every file that *referenced* a changed symbol (tracked via a dependency set recorded during body binding — at minimum "this body referenced symbol X").
- **Import / package / type-alias edit**: treat as project-wide for now (full `GlobalScope` rebind), since these change name resolution globally; a finer model can come later.
- **Reference (`.rsp`) change**: invalidate the whole project (already handled — `ReferenceResolver` and `compilation` are dropped when references change).

The conservative default when a dependency cannot be proven absent is to invalidate, so correctness never depends on the precision of dependency tracking.

### Determinism

Emit must remain bit-for-bit deterministic (the binder/lowerer feed both the LSP *and* `dotnet build`). Two rules:

1. **Reused bodies are identical bodies.** A cached lowered body is only reused when `(stableMemberId, bodyHash)` matches, so it is exactly what a from-scratch bind would have produced. Synthesized names are body-local (fresh `Lowerer`, instance `labelCount`), so reuse cannot perturb a sibling body's names.
2. **No shared mutable counters across bodies.** If body binding is ever parallelized for additional speedup, any synthesized-name source must remain per-method-local (as `labelCount` already is) or be assigned in a deterministic post-pass over a stable member ordering. Parallelizing `BindProgram` *without* this guarantee is explicitly disallowed by this ADR.

The acceptance gate for implementation is that the full emit/IL-verification suite (and the refactoring baseline) is unchanged with delta binding enabled.

### Where the cache lives

The body/symbol caches are **per-project, owned by `ProjectState`**, not stored on a single `Compilation` instance:

- `ProjectState` already owns the per-edit lifecycle (`UpdateFile` → `Invalidate` → `GetCompilation`) and the warm `ReferenceResolver`. It is the natural home for "what did the previous compilation bind."
- `GetCompilation()` changes from "always `new Compilation(trees)`" to "build a new `Compilation` that is *seeded* with the prior per-file symbol tables and body cache, rebinding only the dirty files." The exact seeding mechanism (a new `Compilation` constructor/option vs. an internal binder entry point that accepts prior tables) is an implementation detail deferred to Phase 2, but it must keep `Compilation` immutable-per-instance so the LSP's `ConditionalWeakTable`-keyed model/index caches keep invalidating correctly.

## Consequences

**Positive**

- Per-keystroke latency becomes proportional to *edit size*, not workspace size: a body-only edit re-binds one body instead of ~all of them, targeting the measured ~360–390 ms `BoundProgram` cost directly.
- The design composes with the LSP work already done (parallel reference index, single-pass `SemanticModel`, per-file `Resolve` scoping); those reduced the constant factors, this removes the architectural ceiling.
- Stable symbol identity is independently useful (more robust cross-file navigation and rename).

**Negative / cost**

- Added memory: retaining per-file symbol tables and a body cache across edits.
- Added complexity in the binder's most correctness-sensitive area; invalidation bugs manifest as subtle stale-symbol or stale-diagnostic issues.
- A new invariant (stable identity / no symbol-reference equality in cache keys) that future binder changes must uphold.

**Neutral**

- No change to emitted IL or to non-LSP build behavior; the from-scratch path remains the correctness oracle and the fallback.
- Phase 1 can land first behind the design without user-visible effect until Phase 2 enables cache hits; this de-risks the rollout but means Phase 1 alone is not shippable as a perf win.
- This ADR targets only the *per-keystroke* (warm) cost. The *cold-start* cost — the ~880–940 ms first-open bind, dominated by one-time reference metadata loading — is a separate axis tracked in issue #868 (a cross-session cold-start cache, analogous to C# Dev Kit's `.lscache`). The two are complementary and share the determinism / content-addressed-key requirements stated here.

## Alternatives considered

- **Do nothing / keep optimizing constant factors.** Rejected: the measured ~360–390 ms is the re-bind floor; no constant-factor work removes it.
- **Parallelize `BindProgram` only.** Binding bodies concurrently could cut wall-clock time, but it risks non-deterministic synthesized names (shared counters) and still does *O(workspace)* work per keystroke. Useful as a complementary optimization, but not a substitute for delta binding, and gated on the determinism rule above.
- **Lazy / on-demand body binding for only the active file.** Bind the edited file's bodies eagerly and defer others until requested. Simpler, but diagnostics are inherently whole-project (an edit in file A can introduce errors surfaced in file B), so "active file only" gives wrong/partial diagnostics. Delta binding keeps whole-project correctness while doing minimal work.
- **Coarse per-file body cache keyed by `SyntaxTree`/span without stable identity.** Cheap to build but unsound: spans shift on edits and symbols are fresh per compilation, so reused bodies would reference stale symbols. Rejected in favor of explicit stable identity.
- **Reuse the existing `Compilation.Previous` chain.** Rejected: it is append-only and cumulative, with no replace-one-file semantics; modeling an edit as "append" would grow the chain unboundedly and re-bind cumulatively.

## Acceptance criteria (from issue #866)

- Editing inside a single method body in a large multi-file project re-binds only that body (and genuinely dependent reanalysis), not the whole program.
- Emit remains bit-for-bit deterministic.
- No regressions in diagnostics / hover / definition / completion correctness.
