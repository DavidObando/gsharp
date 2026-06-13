# ADR-0004: Generics — consumption and definition in a single phase, with constraints

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 4 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.2.5; execution plan §0 D4, §4; design doc D4; ADR-0020; **ADR-0087 (implementation-status addendum — reified-generics emit, R1–R7 implemented)**

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

## Implementation-status addendum (2026-06-12) — superseded by ADR-0087 R1–R7 (2026-06-13)

At ADR-0087's authoring (2026-06-12) the "Adopt CLR reified generics (no erasure)" commitment in §Decision was not yet fully delivered. The emit pipeline carried a type-erased fallback for open generic shapes (open user-declared types, open generic methods, closed CLR generics whose type arguments mention an in-scope type parameter, and delegate shapes that bear open type parameters). ADR-0087 catalogued every erasure site, specified the target reified metadata, and staged the elimination across phases R1–R7.

**Status (2026-06-13): the addendum is closed.** All seven phases (R1–R7) have shipped. The commitment in §Decision is fully delivered:

- User-declared generic types and methods emit `TypeDef` + `GenericParam` + `GenericParamConstraint` rows; reflection round-trips them exactly as a C#-defined equivalent does.
- Field, parameter, return, and local signatures over `T` encode `Var(idx)` / `MVar(idx)`.
- Closed CLR generics over an in-scope type parameter (`List[T]`, `Dictionary[string, T]`) encode as honest `GenericInstantiation` blobs.
- Open-bearing delegate shapes (`func(T) U`) emit as a reified `Func<!T, !U>` and dispatch through normal `callvirt Func`N::Invoke` MemberRefs parented at a constructed `TypeSpec` — no `Delegate.DynamicInvoke`, no box/unbox at the boundary.
- The previous "type-erased handling for open type-parameter-containing shapes" caveat is gone from the feature matrix, spec, FAQ, and `clr-interop.md`.

See ADR-0087 §3 (target metadata), §5 (staging plan as implemented), and §6 (closing status). Issue #484 ("Investigate path out of type erasure in the generics implementation") was superseded by issue #728 + ADR-0087 and is closed.
