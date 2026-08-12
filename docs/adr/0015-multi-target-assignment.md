# ADR-0015: Multi-target assignment evaluation order

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 2 (statement form), extended by issue #3353
- **Related**: execution plan §2.3, issues #2234 and #3353

## Context

GSharp's multi-target assignment began with identifier targets and one right-hand
expression per target. Issue #3353 extends it to existing storage locations and
to one tuple-valued RHS:

```gsharp
arr[i], box.Value = 1, 2
a, b = Pair()
```

Storage targets add a third ordering question: when are receiver, index, and
address components evaluated?

The legacy `:=` multi-declaration form was removed by ADR-0077.

## Decision

GSharp uses this fixed three-phase order:

1. Evaluate every target's receiver, index, pointer, and storage-address
   components left-to-right.
2. Evaluate every RHS value left-to-right, once, into temporaries.
3. Perform writes left-to-right.

Targets may be writable locals, fields, properties, array/map/CLR-indexer
elements, nested member targets, or pointer dereferences. Each target is checked
by the same assignment binder used for a single `target = value`, so readonly,
init-only, accessibility, and conversion rules stay identical.

When multiple targets have one RHS, that expression must have tuple type with
matching arity. It is evaluated once into a tuple temporary, then each element
is converted using the corresponding target's normal assignment conversion.
Discards consume their element without writing.

If target capture or RHS evaluation throws, no write occurs. A setter or other
write-time exception can occur after earlier left-to-right writes.

## Consequences

- `a, b = b, a` swaps cleanly.
- `i, a[i] = i + 1, "x"` writes to the slot named by the original `i`.
- `a[i], a[next()] = Pair()` captures both indexes before calling `Pair`.
- Aliasing and value-type receivers retain original storage locations.
- Existing assignment bound nodes and emit paths perform final writes; no
  multi-assignment-specific emitter path exists.

## Alternatives considered

- **Right-to-left or unspecified evaluation order**: rejected; multi-target assignment is a teaching feature, and unspecified order leads to subtle bugs that a beginner-friendly language should not invite.
- **Capture storage targets in cs2gs**: retained only for lowering shapes with no
  native flat assignment form. Native storage-target assignment now owns the
  ordering contract, avoiding redundant `__spillN` and `__deconN` temporaries.
