# ADR-0110: Nested type declarations

- **Status**: Accepted
- **Date**: 2026-06-20
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #910 (nested type declarations inside a class/struct are unsupported and produce a misleading parse-error cascade)
- **Related**: ADR-0017 (sealed-by-default classes); ADR-0078 (sealed hierarchies); #526/#569 (construction/type-clause resolution of *imported* CLR nested types); ADR-0109 (top-level accessibility)

## Context

A `class` or `struct` body could not declare a nested type. The
class/struct body member loop in `Parser.cs` dispatched only on member
kinds — fields (`var`/`let`), `func`, `prop`, `event`, `init`,
constructors, and destructors — and had **no** production for the
`class` / `struct` / `interface` / `enum` keywords. A nested type
declaration was therefore misparsed as a malformed field, which cascaded
into a sequence of misleading errors, e.g.:

```gsharp
class Outer {
    class Inner {                 // GS0113 Type '' doesn't exist
        func Hello() string {     // GS0288 field-keyword expected
            return "hi"
        }
    }                             // GS0005 unexpected <ClassKeyword>
    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}
```

Nested types were simply absent from the aggregate-member grammar even
though the rest of the pipeline already had most of the machinery: the
binder registers every user type in a flat type-alias scope, and the
emitter already produced CLR nested `TypeDef`s for compiler-synthesized
state machines and closures (`EmitNestedStructTypeDef`,
`AccessibilityMap.MapNestedTypeAccessibility`,
`MetadataBuilder.AddNestedType`). What was missing was a source-level
spelling and the wiring to make a *user-declared* nested type flow
through parse → bind → emit.

A hard constraint shapes the emit design: ECMA-335 §II.22.32 requires
the **enclosing** `TypeDef` row to precede the **nested** `TypeDef` row,
and the `Field`/`MethodDef` list columns must be monotonically
non-decreasing across `TypeDef` rows. The emitter historically assigned
rows in a fixed kind-partitioned order: interfaces → classes → structs →
enums → `<Program>` → state-machine types. That order guarantees
"enclosing before nested" for *some* kind/encloser combinations but not
all of them (a nested `interface`, or a `class` nested in a `struct`,
would place the nested row before its encloser). The Decision below
replaces it with a unified pre-order nested block that satisfies the
constraint for every combination.

## Decision

### Grammar

`class` / `struct` / `interface` / `enum` are accepted as members of a
`class` or `struct` body. The body member loop detects an (optional
accessibility modifier followed by an) aggregate-declaration head and
reuses the existing top-level `ParseAggregateDeclaration` routine, so a
nested type is parsed by exactly the same code as a top-level one. The
parsed nested declarations are stored on a new
`StructDeclarationSyntax.NestedTypes` list. Because the top-level
routine is reused, nesting is **recursive**: a nested type may itself
contain nested types (`Outer.Middle.Inner`).

### Binding & name resolution

`DeclarationBinder.BindNestedTypeDeclarations` binds each nested
declaration through the same per-kind binders used for top-level types
and calls `SetContainingType` on the resulting symbol
(`StructSymbol`/`EnumSymbol`/`InterfaceSymbol` each gained a
`ContainingType` property). Nested types register in the same flat
type-alias scope as top-level types, keyed by their **simple** name.

Consequences of the flat scope:

- A nested type resolves by its **unqualified** simple name from
  anywhere the type is visible — in particular from the enclosing type's
  own members, which satisfies the issue's `Inner()` construction inside
  `Outer.Make()`.
- Qualified `Outer.Inner` resolution for **user-declared** nested types
  is *not* newly added here. (Dotted resolution of *imported* CLR nested
  types via `#526`/`#569` is unaffected.) Authors reference a nested user
  type by its simple name.
- Because the simple name is global, two distinct enclosers cannot
  declare nested types with the same simple name in one compilation; the
  second triggers the normal "symbol already declared" diagnostic.

### Accessibility

A nested type's IL visibility is mapped with
`AccessibilityMap.MapNestedTypeAccessibility`
(`internal → NestedAssembly`, `private → NestedPrivate`, otherwise
`NestedPublic`) and it is emitted with an empty namespace; the enclosing
`TypeDef` qualifies the name.

### Emit

`TypeDefEmitter.EmitStructTypeDef` / `EmitEnumTypeDef` /
`EmitInterfaceTypeDef` are nested-aware: when `ContainingType != null`
they use the nested accessibility flags and empty namespace.
`ReflectionMetadataEmitter` adds a `NestedClass` row
(`AddNestedType(nested, enclosing)`) for every user nested type, with the
enclosing handle taken from `cache.StructTypeDefs[containingType]`.

#### Unified emission order (ECMA-335 §II.22.32 compliant)

ECMA-335 §II.22.32 requires every nested type's `TypeDef` row to come
*after* its enclosing type's `TypeDef` row — otherwise the CLR loader
rejects the image with `BadImageFormatException: Enclosing type(s) not
found`. The original implementation emitted `TypeDef` rows in a fixed
*kind-partitioned* order (interfaces, then classes, then structs, then
enums). No fixed kind order can satisfy bidirectional nesting: a
`struct`-in-`class` needs `class` rows before `struct` rows, while a
`class`-in-`struct` needs the opposite — a contradiction. Nested
interfaces are even worse, since interfaces were always emitted first.

`ReflectionMetadataEmitter.EmitCore` therefore emits all **user nested
types in a single contiguous block** placed *after* every top-level type
and *before* the per-package `<Program>` and state-machine `TypeDef`s.
Within that block, types are visited in a stable **pre-order traversal**
(`nestedOrdered`): each enclosing type is emitted first, then its direct
children (kind-sorted interface → class → struct → enum), recursing into
each child before its next sibling. Because every enclosing type — be it
top-level or an outer nested type — is emitted before any of its
descendants, §II.22.32 holds for *all* kind/encloser combinations.

The same `nestedOrdered` sequence drives all four metadata passes —
field-row planning, method-row planning, `TypeDef` emission, and
`MethodDef` body emission — so the monotonically non-decreasing
`FieldList`/`MethodList` columns of the `TypeDef` table stay consistent
(each `TypeDef` owns a contiguous field/method range). The `NestedClass`
table is likewise populated in `nestedOrdered` order, which yields nested
`TypeDef` RIDs in increasing order and keeps that sorted metadata table
valid. Top-level (non-nested) programs produce an empty nested block, so
their metadata is **byte-identical** to before the refactor.

### Supported combinations

All four nested kinds in both enclosers are emitted as **true CLR nested
types**, verified to pass ilverify and execute:

| Nested kind | in `class` | in `struct` |
|-------------|:----------:|:-----------:|
| `class`     | ✅          | ✅           |
| `struct`    | ✅          | ✅           |
| `enum`      | ✅          | ✅           |
| `interface` | ✅          | ✅           |

This covers the issue's core requirements and every kind/encloser
combination — including the nested `interface` (any encloser) and nested
`class`-in-`struct` cases that an earlier iteration deferred. Recursive
nesting works to arbitrary depth.

## Consequences

**Positive**

- The issue's exact example compiles, passes ilverify, and runs.
- All eight kind/encloser combinations are emitted as real CLR nested
  types with correct nested accessibility, usable from the enclosing
  type's members and reflectable as `Outer+Inner`.
- Recursive nesting works to arbitrary depth.
- The unified pre-order emission block lifts the earlier ECMA-335
  §II.22.32 ordering limitation for *all* kinds while keeping non-nested
  programs byte-identical, so there is no remaining nested-type
  diagnostic to surface.

**Negative / out-of-scope**

- User-declared nested types are visible by their **simple** name across
  the whole compilation; qualified `Outer.Inner` resolution for user
  types is not added here, and two enclosers cannot reuse a nested simple
  name.

**Neutral**

- No change to imported CLR nested-type resolution (`#526`/`#569`).

## Test coverage

- **Parser** (`Issue910NestedTypeParserTests`): all four nested kinds in
  both `class` and `struct` enclosers, recursive nesting, accessibility
  modifier on a nested type, and sibling members alongside a nested type.
- **Binder** (`Issue910NestedTypeBinderTests`): `ContainingType` is set
  for every nested kind/encloser combination (class, struct, interface,
  enum) and recursive `ContainingType` chaining.
- **Emit** (`Issue910NestedTypeEmitTests`): the issue's exact example
  plus every kind/encloser combination compiles, passes ilverify, and
  executes — including a `class`-in-`struct` constructed and used from an
  enclosing method, and a nested `interface` (in both a `class` and a
  `struct`) implemented by a sibling nested class and dispatched through;
  a reflection assertion proves `Inner` is a real CLR nested type of
  `Outer`.

## Alternatives considered

- **Diagnostic-only (no real support).** The issue offered a fallback of
  emitting a clear dedicated diagnostic for *all* nested declarations.
  Rejected: it leaves a useful, widely-expected language feature
  unimplemented when most of the infrastructure already existed. We
  implement real nesting for every kind/encloser combination.
- **Fixed kind-partitioned emission order.** Keeping the historical
  interface/class/struct/enum partition order cannot satisfy
  bidirectional nesting (`struct`-in-`class` and `class`-in-`struct`
  impose contradictory partition orders, and nested interfaces can never
  follow their encloser). Rejected in favour of the unified pre-order
  nested block.
- **Emit nested types as top-level types.** They would run but would not
  be true CLR nested types, silently diverging from the declared shape.
  Rejected in favour of real nesting.
