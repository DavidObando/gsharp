# ADR-0167: Checked reference conversion calls

- **Status**: Accepted
- **Date**: 2026-08-18
- **Phase**: Phase 9 — language depth / CLR conversion parity
- **Related**: ADR-0045 (boxing/unboxing), ADR-0115 (cs2gs), ADR-0120 (user conversions), ADR-0160 (`as` yields nullable), issue [#3421](https://github.com/DavidObando/gsharp/issues/3421), parent [#3394](https://github.com/DavidObando/gsharp/issues/3394)

## Context

G# already uses the type-call form for explicit conversions:

```gs
int32(value)
T(value)
T?(value)
```

Reference downcasts were the exception. cs2gs rendered C# `(T)value` as
`(value as T)!!`. That changes an incompatible-value failure from
`InvalidCastException` to a null-assertion failure and made 648 translated Core
casts read like expected-to-fail testing conversions.

## Decision

`cast[T](value)` and `cast[T?](value)` are unambiguous,
constructor-independent checked reference conversions. The existing
`T(value)` / `T?(value)` conversion-call forms remain available when no
construction ambiguity exists.

- `cast` is reserved in call position. `cast(...)` and `cast[...](...)` always
  bind as intrinsic attempts; user functions or types named `cast` cannot
  intercept them.
- A compatible non-null value returns the same reference typed as `T`/`T?`.
- A null reference stays null.
- An incompatible non-null value throws `InvalidCastException`.
- `T?` changes static nullability only; it does not turn the cast into a test.
- `value as T` remains the nullable testing conversion from ADR-0160.
- Numeric, enum, boxing, unboxing, user-defined, checked, and unchecked
  conversions keep their existing behavior.

The binder admits downcasts whose reverse direction is an implicit reference
conversion, legal interface cross-casts, open class/interface cross-casts, and
constraint-proven generic casts. The emitter uses `castclass`; generic targets
use `unbox.any`, matching CLR/C# generic cast semantics. Composite targets use
the same spelling, for example `[]object(value)`.

A named class exposing a one-argument constructor shape reserves `T(value)` for
construction. This is decided from declaration shape without speculatively
binding the argument. Callers requiring conversion use `cast[T](value)`, which
cannot resolve to a constructor. `T?(value)` remains unambiguously a nullable
conversion target.

cs2gs maps every C# explicit reference cast `(T)value` to `cast[T](value)` or
`cast[T?](value)`. Explicit boxing casts to non-`object` reference targets use
the same constructor-independent spelling. Numeric/value casts keep
`T(value)` / `T?(value)`. C# `as` expressions continue to map to G# `as`.

## Consequences

- Core's 648 synthetic checked-cast `as`/`!!` sites become conversion calls.
- Failure and null behavior match C#.
- Genuine pattern/testing conversions remain visibly nullable.
- Checked casts cover named, generic, nullable, interface, dynamic-as-object,
  and composite reference targets without constructor ambiguity.

## Alternatives considered

- **`value as! T`.** Rejected: combines checked-cast semantics with testing-
  conversion syntax and obscures target type.
- **Always emit `T(value)`.** Rejected after review: an applicable one-argument
  constructor constructs instead of casting. Static translation intent must
  survive target constructor shape.
- **Keep `(value as T)!!`.** Rejected: wrong exception semantics and persistent
  translation noise.
- **Make `T?(value)` a testing conversion.** Rejected: nullable annotations do
  not change C# explicit-cast runtime behavior; `as` already supplies testing
  conversion semantics.
