# ADR-0114: Nested (and forward-referenced) class constructor emission

- **Status**: Accepted
- **Date**: 2026-06-21
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #920 (inner/nested classes don't appear to emit `.ctor`)
- **Related**: ADR-0110 (nested type declarations); ADR-0063 §9 (`init(...)` overloads); ADR-0065 §5 (synthesized primary ctor); #306 (base-constructor initializer); #503/#523 (closure / capture-box ctor pre-registration)

## Context

ADR-0110 made user-declared nested types (`class` / `struct` /
`interface` / `enum` inside a `class` or `struct` body) flow through the
binder and emitter as real CLR nested `TypeDef`s. Construction of a
nested type with the implicit/default constructor worked. But a nested
**class** that declared an explicit `init()` constructor failed to emit:

```gsharp
class Outer {
    class CBRecordingBroker : IAuthCallbackBroker {
        prop MfaAnswer string
        init() { MfaAnswer = "000000" }
    }

    func Make() {
        var bb = CBRecordingBroker() { MfaAnswer = "987654" }  // GS9998
    }
}
```

```
error GS9998: InvalidOperationException:
  Type 'CBRecordingBroker' has no emitted primary ctor.
```

### Root cause

The emitter resolves a `newobj` site (`EmitConstructorCall`) by looking
up the constructed type's ctor handle in one of three caches:
`ExplicitCtorHandles` (keyed by the selected `init` overload),
`ClassPrimaryCtorHandles`, or `ClassCtorHandles` (keyed by the
`StructSymbol`). Those caches are populated **while a class's method
bodies are emitted** (`EmitClassMethodBodies`), which records the ctor
handle *before* the class's own methods.

To survive a construction site that is emitted **before** the
constructed class's own body, `EmitCore` pre-registers ctor handles from
the planner's reserved MethodDef rows. The existing pre-registration loop
only covered:

- state-machine classes (iterator/async kickoff `newobj`), and
- synthesized closure classes and capture boxes, plus user classes whose
  ctor is **default-only** (no explicit `init`, no base initializer, no
  primary ctor).

Classes with an explicit `init(...)`, a base-constructor initializer, or
a primary constructor were **not** pre-registered. Their handles only
became available once `EmitClassMethodBodies` reached them.

For nested classes this is fatal *every time*: the enclosing class's
method bodies are emitted in the top-level class pass, which runs
strictly **before** the unified nested-type pass (ADR-0110) that records
nested ctors. So `Outer.Make()` — emitted in the top-level pass — could
never see `CBRecordingBroker`'s ctor handle. The same latent ordering
bug also affected two **top-level** classes when the constructing class
was declared before the constructed explicit-ctor class:

```gsharp
class A { func Make() { let b = B() } }   // GS9998: B has no emitted primary ctor
class B { prop X int32  init() { X = 9 } }
```

The default-ctor nested case worked only because it happened to land in
the pre-registration loop's default-only branch.

## Decision

Generalize the ctor pre-registration in `EmitCore` so **every** non-SM
user class has its constructor handle(s) claimed from the planner's
reserved rows *before any method body is emitted*. The new loop mirrors
`EmitClassMethodBodies`' exact handle assignment, so the pre-registered
handles are byte-identical to those produced during emission:

- **Explicit `init(...)` class** — each declared overload (and the
  synthesized-from-primary designated init) occupies a contiguous
  MethodDef row starting at the planner's `classCtorRows[c]`. Record
  `ExplicitCtorHandles[overload_i] = row + i`; the first overload also
  becomes the `ClassCtorHandles` / `ClassPrimaryCtorHandles` handle.
- **Base-initializer class (#306)** — the single forwarding ctor at
  `classCtorRows[c]` becomes both the class and primary handle.
- **Default-only class** (incl. closures and capture boxes) — the
  default ctor at `classCtorRows[c]` becomes the class handle, plus the
  optional separate primary-ctor row when the class declares a primary
  constructor.

This subsumes the previous closure / capture-box / default-only loop, so
that loop is removed. State-machine classes keep their separate, earlier
pre-registration.

## Consequences

- Nested classes with `init()` constructors now emit correctly and can
  be constructed from an enclosing method, from top-level code, with the
  object-initializer form (`T() { Prop = v }`), and dispatched through an
  interface they implement.
- A latent forward-reference bug for **top-level** explicit-ctor /
  primary-ctor / base-initializer classes is also fixed: a class may now
  construct another class declared later in the file regardless of ctor
  shape.
- No metadata-layout change: pre-registration only claims the rows the
  planner already reserved and the emitter would have produced, so emit
  output for previously-working programs is unchanged (verified by the
  existing ctor/closure/SM/nested emit suites).

## Alternatives considered

- **Reorder emission so constructed types precede constructors.** A
  topological sort over construction edges is fragile (cycles via mutual
  construction are legal) and would perturb MethodDef row order, breaking
  byte-stability for existing programs.
- **Resolve ctor tokens lazily / fix up after emission.** The metadata
  builder appends rows append-only; a second fix-up pass would duplicate
  the row-planning logic the planner already owns. Pre-registering from
  the planner's reserved rows reuses the single source of truth.
