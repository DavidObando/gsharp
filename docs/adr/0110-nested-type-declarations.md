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
non-decreasing across `TypeDef` rows. The emitter assigns rows in a
fixed kind-partitioned order: interfaces → classes → structs → enums →
`<Program>` → state-machine types. That order already guarantees
"enclosing before nested" for several kind/encloser combinations but
*not* for all of them.

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

### Supported combinations

The kind-partitioned emission order already satisfies ECMA-335 §II.22.32
("enclosing row < nested row") for these combinations, which are emitted
as **true CLR nested types** and verified to pass ilverify and execute:

| Nested kind | in `class` | in `struct` |
|-------------|:----------:|:-----------:|
| `class`     | ✅          | ⛔ GS0369    |
| `struct`    | ✅          | ✅           |
| `enum`      | ✅          | ✅           |
| `interface` | ⛔ GS0369   | ⛔ GS0369    |

This covers the issue's core requirements (nested class-in-class and
nested struct-in-struct/class) plus nested enums.

### Deferred combinations (dedicated diagnostic, not a cascade)

A nested **`interface`** (in any encloser) and a nested **`class`
inside a `struct`** would place the nested `TypeDef` row *before* its
enclosing row under the current emission order (interfaces are emitted
first; classes are emitted before structs), violating ECMA-335
§II.22.32 and producing metadata the CLR loader rejects at run time.
Emitting these correctly would require a global enclosing-before-nested
emission order shared by row-planning and emission across all four kind
partitions — a large, risky refactor of the metadata emitter.

For these two combinations the binder reports a **single dedicated
diagnostic, `GS0369`**, instead of the old misleading parse cascade. The
nested type is still parsed and bound (so its body is checked and
references do not produce secondary "type doesn't exist" noise), but it
is not marked nested and the compile fails on `GS0369` alone, with a
message that names the exact unsupported combination and points the
author to move the type to the top level.

## Consequences

**Positive**

- The issue's exact example compiles, passes ilverify, and runs.
- Five of the eight kind/encloser combinations are emitted as real CLR
  nested types with correct nested accessibility, usable from the
  enclosing type's members and reflectable as `Outer+Inner`.
- Recursive nesting works to arbitrary depth.
- The remaining combinations fail with one clear, actionable diagnostic
  instead of a three-error cascade.

**Negative / out-of-scope**

- Nested `interface` (any encloser) and nested `class`-in-`struct` are
  deferred behind `GS0369` until the emitter gains a unified
  enclosing-before-nested type ordering.
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
  for supported combinations, recursive `ContainingType` chaining, and
  `GS0369` fires for the two deferred combinations.
- **Emit** (`Issue910NestedTypeEmitTests`): the issue's exact example
  plus every supported combination compiles, passes ilverify, and
  executes; a reflection assertion proves `Inner` is a real CLR nested
  type of `Outer`; and the two deferred combinations surface `GS0369`
  with no `GS0288`/`GS0005` cascade.

## Alternatives considered

- **Diagnostic-only (no real support).** The issue offered a fallback of
  emitting a clear dedicated diagnostic for *all* nested declarations.
  Rejected: it leaves a useful, widely-expected language feature
  unimplemented when most of the infrastructure already existed. We
  implement real nesting for every combination the emitter can order
  correctly and reserve the diagnostic only for the genuinely
  hard-to-order combinations.
- **Unified enclosing-before-nested emission order for all kinds.** This
  would support every combination but requires reworking row-planning and
  emission across the interface/class/struct/enum partitions
  simultaneously, with high regression risk to the existing emitter.
  Deferred to a follow-up; tracked by `GS0369`.
- **Emit deferred nested types as top-level types.** They would run but
  would not be true CLR nested types, silently diverging from the
  declared shape. Rejected in favour of an explicit diagnostic.
