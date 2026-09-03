# ADR-0167: Checked reference conversion calls

- **Status**: Accepted
- **Date**: 2026-08-18
- **Phase**: Phase 9 — language depth / CLR conversion parity
- **Related**: ADR-0045 (boxing/unboxing), ADR-0115 (cs2gs), ADR-0120 (user conversions), ADR-0160 (`as` yields nullable), issue [#3421](https://github.com/DavidObando/gsharp/issues/3421), parent [#3394](https://github.com/DavidObando/gsharp/issues/3394)
- **Amended**: 2026-09-02 — nullable operands (issue [#3843](https://github.com/DavidObando/gsharp/issues/3843))

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
- **The operand may be reference-nullable.** `cast[T](x)` accepts an `S?`
  operand for every reference direction — identity (`T? -> T`), downcast
  (`Base? -> Derived`), interface cross-cast, and widening (`Derived? -> Base`,
  `Impl? -> IFace`) — and its result is **non-nullable `T`**, exactly as C#
  `(T)x` is statically `T` however maybe-null its operand. Nil flows through
  unchanged; a non-nil value of an incompatible runtime type still throws.
  Like C#, this means an explicitly written cast is the one place a nil can
  inhabit a non-nullable static type, and the dereference that follows raises
  the same `NullReferenceException` C# raises at the same point. This is
  deliberately confined to the EXPLICIT `cast`/conversion-call spelling: no
  implicit conversion drops reference nullability, and the Kotlin-model
  GS0154/GS0155 rules are untouched.
- Value-type and `Nullable[T]` targets keep C#'s own (different) rules:
  `cast[int32](nilObject)` throws `NullReferenceException`, `cast[int32?]
  (nilObject)` yields nil.
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
`cast[T?](value)` — including when `value` is nullable. It briefly (issues
#3567/#3683) lowered a nullable-operand cast to `value as T` instead, on the
premise that `cast[T]` required a non-null operand. That premise held only for
the widening direction, which issue #3843 closed, and the `as` rendering was
wrong twice over: its `T?` result injected a nullable element type into
non-nullable continuations (`Select(cast).Where(x => x != nil).OrderBy(…)`
stopped compiling), and it turned a wrong-type cast from an
`InvalidCastException` into a silent nil. Explicit boxing casts to non-`object` reference targets use
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
