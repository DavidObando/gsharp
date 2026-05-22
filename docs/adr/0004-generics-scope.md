# ADR-0004: Generics — consumption and definition in a single phase, with constraints

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 4 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.2.5; execution plan §0 D4, §4; design doc D4; ADR-0020

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
