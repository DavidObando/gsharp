# ADR-0001: Absence / null model — Kotlin-style nullable types

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 3 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.2.4, §6.1; execution plan §0 D1, §3.C; design doc D1

## Context

Three precedents pull in incompatible directions for "no value":

- **Go** uses `nil` as a per-type zero value, with no compile-time null safety. Errors are carried explicitly via `(T, error)` returns.
- **C#** layered nullable reference types onto a runtime where `null` was always legal; the result is a strong analyzer but no runtime guarantee.
- **Kotlin** makes nullability part of the type from the start (`T?`), with safe-call (`?.`), Elvis (`?:`), null-assert (`!!`), and smart casts.

GSharp targets the CLR (where `null` is always reachable in IL) but values a clean type-system story. The decision must be made before structs, interfaces, or BCL consumption mature, because each layer rewrites in response to the chosen model.

## Decision

Adopt the **Kotlin-style** model:

- Reference types are non-null by default. Nullability is opted into with the postfix `?` type operator: `string?`, `User?`, `List[int]?`.
- Value types use the same `T?` spelling, lowered to `System.Nullable<T>` in IL.
- `nil` is the only inhabitant of the bottom of nullable types; assigning `nil` to a non-nullable is a binder diagnostic.
- Operators: safe call `?.`, null-coalescing `??` (originally spelled `?:`; respelled by ADR-0116, issue #941), null-assert `!!`.
- Flow-typed smart casts narrow a nullable to non-null after a `!= nil` check inside the controlled block.
- The reference resolver honors `[Nullable]` / `[NullableContext]` attributes from imported assemblies so BCL APIs project their declared nullability into GSharp.

## Consequences

Positive:

- Best-in-class ergonomics; smart casts eliminate most explicit `!!` ceremony.
- Aligns with `data struct` synthesis, sealed-interface ADTs, and pattern matching (Phases 3 and 6).
- The "what is GSharp's nil?" question stops blocking every downstream design.

Negative:

- Flow analysis is a known-hard problem; ship a minimal version in Phase 3 (only `if x != nil` narrowing) and harden in Phase 6.
- Requires a coordinated lexer + parser + binder + emit + ReferenceResolver change set in Phase 3.C.

Neutral:

- BCL exceptions for null misuse (`NullReferenceException`) still happen at the IL boundary; the type system reduces but does not eliminate them.

## Alternatives considered

- **C#-style** (nullable annotations + warnings, no runtime guarantee): rejected for weaker ergonomics and no smart-cast guarantee.
- **Go-style** (`nil` legal everywhere, errors via multi-return): rejected as fundamentally incompatible with .NET BCL exception semantics (see ADR-0005).
- **Defer**: rejected; D1 must lock before structs/interfaces (Phase 3) to avoid expensive rework.
