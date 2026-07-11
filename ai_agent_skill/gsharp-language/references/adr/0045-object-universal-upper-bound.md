# ADR-0045: `object` as the universal upper bound

- **Status**: Accepted
- **Date**: 2026-05-26
- **Phase**: Phase 8 — primitive coverage
- **Related**: issue #142, ADR-0001 (null model), ADR-0034 (imported CLR interop), ADR-0044 (numeric primitive coverage)

## Context

ADR-0044 adds `object` to GSharp's keyword table and pins it to `System.Object`. The *spelling* is straightforward; the *semantics* warrant their own ADR because `object` is the seam between GSharp's type system and the CLR's universal upper bound.

Today GSharp has no concept of "every value is assignable to `T`". Reference-type nullability is handled by ADR-0001 (`T?` is the assignable-from-`nil` flavour of `T`), and value types are independently boxed only by the underlying runtime when GSharp calls into imported APIs that take `object`. There is no GSharp-language way to write a variable of type `object`, no GSharp-language assignment that says "box this `int`", no GSharp `is object` pattern, and no GSharp definition of `==` on `object`.

The question is how closely the new `object` keyword matches C# (boxing rules, identity equality, default `ToString` access) vs. how much we trim for GSharp-specific reasons.

## Decision

`object` is the universal upper bound. Specifically:

### Assignment compatibility

* Every reference type is implicitly convertible to `object` (identity reference).
* Every value type is implicitly convertible to `object` via **boxing**. The emit pipeline inserts a `box` instruction on the underlying CLR value type.
* The conversion to `object` is **always implicit**; no cast is required.

Nullability follows ADR-0001:

* `object` is the non-nullable reference type. A `nil` may not be assigned to a variable of type `object`.
* `object?` is the nullable variant; `nil` is assignable, `nil` flows through it, and access requires `?.` / `!`.
* Boxing a value of a value type into `object` produces a non-`nil` reference, exactly as on the CLR.

### Boxing direction and unboxing

* **Box** (value type → `object`) is implicit, as above.
* **Unbox** (`object` → value type `T`) requires an explicit `T(expr)` conversion. At runtime this lowers to the CLR `unbox.any T` instruction; a runtime-type mismatch raises `System.InvalidCastException`, matching C#.
* **Downcast** (`object` → reference type `T`) likewise requires `T(expr)`; this lowers to `castclass T`.
* The `is` pattern (`x is T`) tests the runtime type without raising; success narrows the local in the matching arm (per the existing `is`-pattern flow).

### Equality

* `==` and `!=` on two operands typed `object` resolve to **reference equality** (CLR `ceq`). This matches C# behaviour and ADR-0037's tie-breaking rule.
* Equality between an `object`-typed operand and a value-typed operand: the value operand is boxed and reference equality is used. (This is the C# rule for `object == int`.)
* User-defined `==` operators are not lifted to `object` — to invoke them, both operands must already have the more specific static type.

### Members visible on `object`

`object` exposes the standard `System.Object` instance members imported from the BCL: `ToString()`, `GetHashCode()`, `GetType()`, and `Equals(object)`. These are reached via the existing imported-member pipeline; no GSharp-specific bindings are introduced.

### `nil` and `object`

* `object` cannot hold `nil`; use `object?` for that.
* `nil is object` is `false` (`nil` does not have a runtime type to test against).
* Boxing a `T?` whose value is `nil` produces `nil` in `object?` (CLR behaviour: boxing a null `Nullable<T>` yields a null reference).

### `typeof`

`typeof(object)` returns the `Type` instance for `System.Object`, on the same footing as every other primitive (issue #143).

## Consequences

* Imported APIs that take `object` parameters become trivially callable from GSharp: `Console.WriteLine(42)` works because `int` boxes to `object` on the call.
* Generics involving `T : object` and reflection-heavy APIs become usable without the user having to add a `System.Object` import.
* The conversion table grows: every value-type primitive added by ADR-0044 must list `object` in its implicit-target set, and the emit side must select `box <T>` when the target is `object`.
* `==` on `object` is reference equality, even when the runtime values are `int` boxes — this can surprise users coming from Python or JavaScript. The diagnostic system should not warn on this case (it's a well-known CLR semantic), but documentation in `docs/lexical.md` (or a follow-up doc) should call it out.
* Reference equality means GSharp value-type comparison authors should still use the typed `==` they already define (per ADR-0035 user operator overloads). Boxing-to-`object` to compare is an anti-pattern but is not blocked.
* No new attribute support is required; nullable annotations for `object`/`object?` flow through ADR-0001's existing mechanism.

## Alternatives considered

* **Treat `object` as just another imported type.** Rejected: forcing `import System` plus the `System.Object` spelling every time the user wants a universal upper bound is hostile and breaks parity with the rest of the keyword table.
* **Make `object` nullable by default (`object` ⇔ `object?`).** Rejected because it breaks ADR-0001's invariant that bare reference types are non-nullable; `object?` is the explicit nullable spelling and matches every other reference type.
* **Value-equality for `object == object`.** Rejected as too surprising at the CLR boundary: imported BCL APIs assume CLR semantics, and matching them avoids subtle bugs at the interop seam.
* **Disallow boxing (force callers to write `(object)x` explicitly).** Rejected because it would make every `Console.WriteLine(42)` call site noisy without preventing a meaningful class of bug.
