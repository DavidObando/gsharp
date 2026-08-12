# ADR-0165: Explicit extension receiver clauses

- **Status**: Accepted
- **Date**: 2026-08-12
- **Related**: ADR-0019, ADR-0024, ADR-0079, ADR-0084, ADR-0115; issues #2821, #3357

## Context

The original receiver clause has an ownership-dependent meaning:

```gs
func (value T) M() R
```

It is an extension when `T` is non-owned, but an instance method (and
`GS0314`) when `T` is an owned class/struct. Same-package enums are rejected
with `GS0103`. This leaves no faithful declaration for C# extensions on enums
or extensions that must remain separate from an owned type's real members.
cs2gs consequently emitted static helpers, forcing null-conditional calls and
method groups through spill-heavy rewrites.

## Decision

Add contextual `extension` after `func`:

```gs
func extension (color Color) Describe() string -> color.ToString()
func extension (box Box) Map[T](value T) T -> value
```

`func extension` requires the existing receiver-clause shape. It forces the
declaration to bind as an extension regardless of receiver ownership or
aggregate kind. The receiver remains parameter zero, participates in normal
extension overload resolution and generic inference, and emits as the same
CLR `[Extension]` static method used by non-owned receiver clauses.

The unmarked form is unchanged:

- owned class/struct receiver: instance method plus `GS0314`;
- same-package non-aggregate receiver: `GS0103`;
- non-owned receiver: extension.

`extension` remains contextual, so `func extension(value int32) int32` is
still an ordinary function named `extension`.

## Consequences

- Enum and owned C# extensions can retain member calls, null-conditional
  access, and method groups.
- Explicit extensions do not satisfy owned-type interface contracts and do
  not collide with the owned type's declaration table.
- cs2gs may retain a static helper only when C# source explicitly depends on
  declaring-container identity, by-ref receiver semantics, or an exact
  signature collision. Reduced/member-form calls use an explicit receiver
  companion and need no synthetic receiver spill.
- Value-type extension method groups lower through a capturing adapter because
  CLR closed-static delegates cannot bind a boxed value-type first argument.

