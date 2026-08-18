# ADR-0168: Mixed deconstruction and discard bindings

- **Status**: Accepted
- **Date**: 2026-08-18
- **Phase**: Phase 9 — migration ergonomics
- **Related**: ADR-0015 (multi-target assignment), ADR-0032 (deconstruction), ADR-0115 (cs2gs), issue [#3423](https://github.com/DavidObando/gsharp/issues/3423)

## Context

G# supported immutable tuple declarations and assignment into existing storage:

```gs
let (a, b) = Pair()
a, b = Pair()
```

It lacked two C# deconstruction shapes needed by cs2gs:

```csharp
var (a, b) = Pair();
(existing, var fresh) = Pair();
```

The translator therefore introduced `__deconN` locals, then copied each value
into its final destination.

Expression-form C# `using (Open()) { ... }` also needed a resource slot. G#
already parsed `using let _ = Open()`, but `_` was bound as an ordinary local,
so repeated discard declarations collided in one scope.

## Decision

Tuple declarations accept `var` as well as `let`:

```gs
var (a, b) = Pair()
```

Multi-assignment targets may introduce inferred locals with `let` or `var`:

```gs
existing, let fresh = Pair()
var first, existing = 1, 2
```

Fresh targets have no storage components to capture. Existing targets are still
captured left-to-right, then all right-hand values are evaluated once, then
writes and declarations occur left-to-right. New locals enter scope after the
statement. `_` remains a discard.

An ordinary declaration named `_` receives unique hidden storage and never
enters name lookup. Repeated `let _ = ...` and `using let _ = ...` declarations
therefore coexist while preserving initializer evaluation and disposal.

## Consequences

- cs2gs emits source-owned names for all-fresh and mixed deconstructions.
- Expression-form `using` emits `using let _` without a synthetic source name.
- Mutable tuple locals no longer require an immutable temp plus copy.
- Existing ADR-0015 ordering, conversion, discard, and storage-target rules stay
  unchanged.
- Nested target tuples and expression-valued deconstruction assignments retain
  their recursive lowering.
