# ADR-0003: OO surface — data-oriented core with light OO escape hatch

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 3 (implementation), Phase 0 (lock)
- **Related**: gaps doc §3.2, §6.1; execution plan §0 D3, §3.B; design doc D3

## Context

GSharp's README explicitly steers away from OO heavy machinery, citing Uncle Bob and Joe Armstrong. Yet:

- The .NET BCL is fundamentally OO; consuming it requires understanding classes, virtual dispatch, and interfaces.
- Some user code legitimately wants single inheritance for framework integration (e.g., implementing `Stream`, deriving from `Exception`).
- A pure-Go subset (`struct` + `interface` + composition) leaves users reinventing data-class boilerplate.

## Decision

A **data-oriented core with one OO escape hatch**:

- **`struct`** — Go-style value-type data container. Fields with visibility modifiers (ADR-0006). Lowered to CLR `struct`.
- **`data struct`** — Kotlin data-class equivalent: compiler synthesizes structural equality, hash, `ToString`, `copy(field = newValue)`, and positional destructuring.
- **`interface`** — method signatures, no default impls in Phase 3 (ADR-0018 may reopen).
- **`sealed interface`** — tagged-union semantics for ADTs; all implementors in the same package; exhaustiveness checked in Phase 6 `switch` patterns.
- **`class`** — single inheritance, `override`. Constructors with parameter lists. Visibility modifiers respected. Lowered to CLR class.
  - Two constructor forms are supported (issue #306): a Kotlin-style **primary constructor** (`class C(p T) { … }`) whose parameters declare same-named fields and implicitly chain to a parameterless base ctor, and one **explicit constructor** (`init(params) [: base(args)] { body }`) with an arbitrary statement body that sees `this`, its parameters, and the class fields by bare name. A class may declare *either* form but not both, and at most one `init` constructor. Both forms may forward arguments to a specific base constructor via `: base(args)` / `: Base(args)`, which unlocks inheriting from CLR bases lacking a parameterless ctor (e.g. `System.Exception`).
- **Extension functions** — idiomatic way to add behavior to user types and imported CLR types; resolved at the call site as static dispatch with a leading receiver argument.

Multi-inheritance, abstract classes, mixins, traits — out of scope.

## Consequences

Positive:

- Covers every BCL interop case (single inheritance + interfaces is enough for `IDisposable`, `IEnumerable`, `Stream`, `Exception`).
- `data struct` + `sealed interface` together obviate the C# proposals for records and discriminated unions (gaps doc §3.2.1, §3.2.2).
- Extension functions match Go's "free functions in a package" idiom while remaining strongly-typed.

Negative:

- More surface to land than a pure-Go subset. Mitigation: ship in the order `struct` → `data struct` → `interface` → `sealed interface` → `class` → extensions; each is independently usable.
- Two ways to add behavior to a type (methods-with-receivers per ADR-0024 vs extension functions). ADR-0024 will pick a canonical style for new user code in Phase 6.

Neutral:

- The `class` escape hatch may attract Java/C# users back toward OO patterns. Style guidance in v1.0 spec will steer toward data-oriented design.

## Alternatives considered

- **Strict Go**: only `struct` + `interface`, no classes, no sealed types. Rejected because BCL interop requires inheriting from CLR classes in some cases.
- **Data-oriented only** (no `class`): rejected for the same reason.
- **Full OO** (multi-inheritance, mixins): rejected — contrary to README philosophy and adds complexity without proportionate value.
