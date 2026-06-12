# ADR-0004: Generics — consumption and definition in a single phase, with constraints

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 4 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.2.5; execution plan §0 D4, §4; design doc D4; ADR-0020; **ADR-0087 (implementation-status addendum — open-shape erasure audit and staged elimination)**

## Context

The .NET BCL is generic top-to-bottom: `List<T>`, `Dictionary<K,V>`, `Task<T>`, `IEnumerable<T>`, `Span<T>`. Without generics, GSharp cannot consume `System.Collections.Generic` meaningfully. Two possible sequencings:

- **Two-phase**: Phase 4 ships consumption only; Phase 6 adds definition. Lower initial cost, but every user-defined collection wrapper must wait, and the public surface (and tooling) changes between phases.
- **One-phase**: Phase 4 ships both. Higher up-front cost; no public-surface migration.

## Decision

Ship **both consumption and definition** in Phase 4, with **type-parameter constraints** (`any`, `comparable`, sealed-interface bounds). Adopt CLR reified generics (no erasure). Variance modifiers (`in`/`out`) on interface type parameters per ADR-0021. Syntax: Go-style `[T]` brackets per ADR-0020.

```gs
func Map[T, U any](xs []T, f func(T) U) []U { ... }
data struct Pair[A, B any](first A, second B)
let nums = List[int]()
let xs   = Dictionary[string, User]()
```

## Consequences

Positive:

- Unblocks all serious BCL usage in one go.
- No two-step migration for users or tooling.
- Aligns with `data struct` + sealed types — generic ADTs (`Result[T, E]`) are immediately expressible.

Negative:

- Phase 4 is the largest single-phase work item after Phase 3. Mitigation: explicit work-item decomposition in execution plan §4.
- Generic-method emit, constraint emission, and BCL closed-generic specialization must all land together.

Neutral:

- Reified generics align GSharp with C# and Kotlin (on JVM with reflection) rather than with Go (where parametric polymorphism is monomorphized).

## Alternatives considered

- **Consumption only, indefinitely**: rejected; users cannot define their own generic data containers, which is too restrictive for any non-trivial library.
- **Two-phase (consumption first, definition later)**: rejected to avoid migrating users across a public-surface change.
- **Defer all generics**: rejected; without generics consumption, GSharp cannot meaningfully use `System.Collections.Generic` or `Task<T>`.

## Implementation-status addendum (2026-06-12)

The "Adopt CLR reified generics (no erasure)" commitment in §Decision is not yet fully delivered. The current emit pipeline carries a type-erased fallback for open generic shapes (open user-declared types, open generic methods, closed CLR generics whose type arguments mention an in-scope type parameter, and delegate shapes that bear open type parameters). See ADR-0087 for:

- the complete audit of every erasure site in the binder/lowering/planner/emitter (53 sites across 14 source files in categories F1–F4 that materially affect reflection-correctness),
- the target CLR metadata shape per category (`TypeDef`+`GenericParam`+`GenericParamConstraint` rows, `TypeSpec`/`MethodSpec` instantiations, `Var`/`MVar` signature encoding, generic-context-aware MemberRef parents),
- the staged elimination plan (R1–R7),
- the reflection-based golden suite that pins current behaviour so each staging phase is bisectable,
- and the explicit deferral of the implementation phases beyond this ADR's date.

Issue #484 ("Investigate path out of type erasure in the generics implementation") is superseded by issue #728 + ADR-0087.
