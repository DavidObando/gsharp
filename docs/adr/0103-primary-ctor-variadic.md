# ADR-0103: Variadic (`...T`) parameters on primary-constructor parameter lists

- **Status**: Accepted
- **Date**: 2026-08-08
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #819 (lift the primary-ctor carve-out left by ADR-0102)
- **Related**: Parent #706; ADR-0078 (#674, primary-constructor parameter
  lists as the canonical declaration form for class/struct/data/inline);
  ADR-0101 (#799, variadic v1, top-level only); ADR-0102 (#812, lift to
  ordinary constructors, methods, lambdas, named delegates).

## Context

ADR-0078 introduced primary-constructor parameter lists as the canonical
declaration form on `class`, `open class`, `data class`, `struct`,
`data struct`, and `inline struct`. Every parameter in that list
promotes to an auto-field of the same name and the synthesised
constructor body assigns it.

ADR-0101 introduced the `name ...T` variadic parameter spelling on
top-level `func`. ADR-0102 (#812) lifted the carve-out to ordinary
constructors (`init(…)`), instance/static/interface methods, lambdas,
and named delegates. Primary constructors were the one site explicitly
left behind, because the auto-field shape for a variadic parameter is a
design question: the promoted field's type, its initial value, and the
caller-visible mutability story all have to be pinned before the lift
is safe. The deferral was tracked as #819.

Today, the workaround is an explicit `init(name string, tags ...string)`
body plus a hand-declared `Tags []string` field — verbose and
inconsistent with the rest of the type-declaration vocabulary.

```g#
class Tags(name string, ...tags string)   // GS0146 today
```

## Decision

Lift the primary-constructor carve-out. A primary-ctor parameter list
on any of the five declaration sites (`class`, `struct`, `data class`,
`data struct`, `inline struct`) accepts a single trailing variadic
parameter `name ...T`. The structural rules from ADR-0101 — *at most
one variadic per signature, must be last, no `params` keyword, element
type wrapped in `SliceTypeSymbol`, emit `ParamArrayAttribute` on the
trailing parameter* — apply unchanged.

### Auto-field shape (the design call)

The variadic primary-ctor parameter **promotes to a `[]T` auto-field
with the same name**, exactly as the explicit-ctor lowering does
today.

```g#
class Tags(name string, tags ...string) { /* … */ }
```

is equivalent (in surface semantics and in emitted IL shape) to:

```g#
class Tags {
  var name string
  var tags []string

  init(name string, tags ...string) {
    this.name = name
    this.tags = tags
  }
}
```

That equivalence yields three pinned choices:

1. **Field type**: `[]T` (`SliceTypeSymbol.Get(elementType)`).
   Not `IEnumerable[T]`, not `T[]?`, not `IReadOnlyList[T]`. The slice
   spelling is the language-level type; the underlying runtime
   representation continues to be a single-dimensional zero-based
   `T[]` (see ADR-0083 for the slice ↔ array equivalence in emit).
2. **Field name**: the parameter's source name — `tags` for
   `tags ...string`. There is no rename, no suffix, no plural folding,
   matching every other primary-ctor parameter.
3. **Initial value**: whatever the call site supplies. Variadic
   packing semantics from ADR-0101 apply unchanged:
   - Multiple positional tail arguments → freshly allocated `[]T`
     containing those arguments (`BoundArrayCreationExpression`).
   - Zero tail arguments → freshly allocated empty `[]T` of length 0.
   - A single argument that is already `[]T` → pass-through, same
     reference (no copy). Mutating the caller's array after the call
     is observable through the promoted field. This is identical to
     existing variadic call semantics on functions and `init`.

### Site coverage

| Site            | Variadic primary-ctor accepted? |
| --------------- | ------------------------------- |
| `class`         | Yes                             |
| `open class`    | Yes                             |
| `struct`        | Yes (struct-literal init only)  |
| `data class`    | Yes                             |
| `data struct`   | Yes (struct-literal init only)  |
| `inline struct` | Yes                             |

For value-type `struct` / `data struct`, the language only exposes the
struct-literal initialisation form (e.g. `Ids{values: []int32{1,2,3}}`)
— the variadic field is still promoted and the literal slot accepts
a `[]T` value. There is no call-syntax `Ids(1, 2, 3)` for value
structs today; that surface is orthogonal to this ADR.

For `inline struct`, the variadic param promotes the single field
exactly as the existing single-field synthesis path produces, with
`[ParamArrayAttribute]` carried through.

### Generics

Generic primary-ctor variadic works through the existing type
substitution machinery:

```g#
class Box[T](first T, rest ...T) { }

var b = Box[int32](1, 2, 3, 4)
// b.first == 1, b.rest == []int32{2, 3, 4}
```

`StructSymbol.Construct` propagates the parameter's `IsVariadic` flag
when substituting type arguments, so a generic primary-ctor variadic
binds with the same pack / pass-through dance as the non-generic form.
Type inference from a single tail `[]T` argument infers
`T = elementType`; from multiple tail arguments it infers from the
element types directly. This matches ADR-0101.

### Diagnostics

- **GS0145** (variadic must be last) fires when a primary-ctor
  parameter list places non-variadic parameters after the variadic.
- **GS0364** (multiple variadics) fires when a primary-ctor list
  declares more than one variadic parameter.
- **GS0146** is no longer reported for primary-ctor sites (it remains
  defined for ID stability).
- **GS0147** (too few fixed args for variadic call) fires at the call
  site when the caller supplies fewer arguments than the number of
  fixed leading parameters.

### Emit

- `TypeDefEmitter.EmitClassPrimaryConstructor` and
  `EmitClassConstructorWithBaseInitializer` now emit a Parameter row
  for every primary-ctor parameter (giving each a metadata name) and
  stamp `[ParamArrayAttribute]` on the trailing variadic slot via the
  existing `EmitParamArrayAttributeOnParameter` helper used by the
  rest of the variadic emit path.
- The variadic auto-field is emitted with type `T[]`, identical to
  the lowering an explicit `init(...)` body would produce.
- ilverify gates every emitted assembly clean.

### Cross-language interop

A C# consumer sees `[ParamArrayAttribute]` on the synthesised
constructor's trailing parameter, so `new Tags("a", "b", "c")` lowers
through C# `params` overload resolution exactly like any other G#
variadic constructor.

## Consequences

- One less reason to fall back to explicit `init` blocks. Primary
  constructors are now a faithful single-line form for "fixed prefix
  + trailing collection" types like `Tags`, `Words`, `Pipeline`.
- The auto-field's mutability story mirrors existing variadic
  semantics: when the caller passes a single `[]T` it is the same
  reference. Defensive copies remain the caller's responsibility.
- No new `BoundNodeKind` or `SyntaxKind` is introduced. Parser-level
  acceptance was already in place via ADR-0102's shared
  parameter-syntax updates; the work was concentrated in the binder
  (parameter promotion + call binding) and emitter (Parameter rows +
  custom attribute).
- The carve-out in ADR-0102 (§4 "Constructors", *Out-of-scope* bullet
  on primary constructors) is retired by this ADR.

## References

- Issue #819 — primary-constructor variadic parameters.
- Parent #706 — ADR-0078 type-declaration grammar harmonisation.
- ADR-0078 (#674) — primary-constructor parameter lists.
- ADR-0101 (#799) — variadic v1 on top-level functions.
- ADR-0102 (#812) — variadic on additional sites; explicitly defers
  primary constructors.
- ADR-0083 — slice ↔ array equivalence in emit.
