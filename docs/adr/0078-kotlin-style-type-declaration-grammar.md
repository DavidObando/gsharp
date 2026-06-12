# ADR-0078: Kotlin/Swift-style type-declaration grammar

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Phase 9 — language depth / surface cleanup
- **Related**: parent [#706](https://github.com/DavidObando/gsharp/issues/706), this ADR [#718](https://github.com/DavidObando/gsharp/issues/718), also lands [#725](https://github.com/DavidObando/gsharp/issues/725) (discriminated-union enums). Pairs with ADR-0077 (drop `:=`). Supersedes ADR-0029 (`record` alias / synthesized members spelling) and the declaration-head sections of ADR-0017, ADR-0018, and ADR-0033 (see the "Supersession" section).

## Context

Through Phase 8 every nominal aggregate (class, struct, enum, interface,
record) was declared with the same Go-style head:

```
type Name <kind> { ... }
```

where `<kind>` was one of `class`, `struct`, `enum`, `interface`, plus
the standalone `record` keyword introduced by ADR-0029. The pattern was
inherited from the original Go-flavoured surface and kept consistent
with `type Count = int32` aliases and `type Greeter = delegate func(...)`
named delegates.

Modernising the language with Kotlin/Swift ergonomics (ADR-0070..0077)
revealed two pain points:

1. **Redundant `type` keyword.** Reading `type Animal class` requires
   the reader to skip a noise-word before the meaningful one. Every
   peer language (Kotlin, Swift, Scala, Rust, C#) drops the `type`
   noise-word for aggregate declarations and uses the kind word as the
   declaration keyword. The Go-style head is the **only** declaration
   form in G# that still leads with `type`.
2. **Combinatorial explosion of declaration kinds.** Sealed classes
   (ADR-0017 §3 future work), inline value classes (ADR-0033),
   `record` (ADR-0029, value-typed), `data class` / `data struct`
   (planned), and discriminated-union enums (#725) all required new
   ad-hoc declaration heads. The `type Name kind` form had no slot
   for modifiers between `type` and `kind`, so each new combination
   either reused an existing keyword (`record` ≈ `data struct`,
   confusing) or invented a fresh production (`inline struct`).

`record` (ADR-0029) is the canonical example of the problem:
`record Point { x int32; y int32 }` was effectively a `data struct`
spelled with a separate keyword. ADR-0029 deferred unification on the
grounds that the Kotlin/Swift surface wasn't yet adopted; the rest of
that surface has now landed (ADR-0070..0077), so unifying the head is
the next obvious step.

## Decision

### 1. Canonical declaration head

The grammar for every nominal aggregate becomes:

```ebnf
AggregateDeclaration
    : Visibility?
      OpenOrSealed?
      Data?
      Inline?
      AggregateKeyword
      Identifier
      TypeParameterList?
      PrimaryConstructor?
      BaseClause?
      AggregateBody?
    ;

Visibility         : "public" | "internal" | "private" ;
OpenOrSealed       : "open" | "sealed" ;
Data               : "data" ;
Inline             : "inline" ;
AggregateKeyword   : "class" | "struct" | "enum" | "interface" ;

PrimaryConstructor : "(" Parameters? ")" ;
BaseClause         : ":" Type ("," Type)* ;
AggregateBody      : "{" Member* "}" ;
```

The aggregate keyword IS the declaration keyword. The `type` noise-word
is **removed** from aggregate declarations entirely. The `record`
keyword is **deleted**.

### 2. Spelling matrix

| Aggregate | Spelling |
|---|---|
| Reference class (sealed-by-default) | `class Animal(name string)` |
| Open reference class | `open class Animal(name string)` |
| Sealed class (closed hierarchy, new) | `sealed class Shape` |
| Record (reference, equality-bearing) | `data class Person(name string, age int32)` |
| Record (value, equality-bearing) | `data struct Point(x int32, y int32)` |
| CLR struct | `struct Point(x int32, y int32)` |
| Inline value class (newtype) | `inline struct UserId(value string)` |
| Enum (flat) | `enum Color { Red, Green, Blue }` |
| Enum (discriminated union) | `enum Shape { Circle(r float64); Square(s float64) }` |
| Interface | `interface Drawable { func Draw() }` |
| Sealed interface | `sealed interface Shape { }` |

### 3. Combination rules

The following are the only legal modifier combinations. Every other
combination is hard-rejected at parse time with a precise diagnostic.

1. `data class` and `data struct` are both admitted; both synthesize
   structural equality (`==`, `!=`, `GetHashCode`), a `with`-copy
   member, and named deconstruction. The synthesis pipeline is shared
   with the legacy `record` (ADR-0029) implementation.
2. `inline` is only admitted with `struct`. `inline class` is rejected.
3. `sealed` is admitted with `class` and `interface` only. `sealed
   struct` and `sealed enum` are rejected.
4. `open` is admitted with `class` only. `open struct`, `open enum`,
   and `open interface` are rejected (interfaces are implicitly open;
   structs cannot be inherited from).
5. `enum` is a single parser production with two binding paths:
   a. **flat**, when every member has no payload (`enum Color { Red,
      Green, Blue }`),
   b. **discriminated union**, when at least one member carries a
      payload (`enum Shape { Circle(r float64); Square(s float64) }`).
6. Primary-constructor parameter lists (`Name(p1 T1, p2 T2)`) are the
   canonical declaration form. Each parameter is lifted to a public
   field of the same name and type per ADR-0067.
7. The `record` keyword is deleted. Migration: `record X { ... }` →
   `data struct X { ... }` (preserving value semantics).

### 4. Sealed-class hierarchy semantics

`sealed class Shape` marks a closed hierarchy: subclasses are allowed
in the declaring assembly, but the CLR class is **not** emitted with
the `Sealed` type attribute (which would block subclassing). The
binder permits `class Circle : Shape` when `Shape` is sealed-hierarchy.

Exhaustiveness checking treats the sealed base as a discriminant: a
`switch` over a value of the base type that does not cover every
declared subtype emits `GS0313` (exhaustiveness warning), exactly as
for flat enums. `sealed interface` works analogously.

Plain `class Foo` (no `open`, no `sealed`) is still CLR-sealed by
default — the distinction is *open* (any package can subclass) vs.
*sealed-hierarchy* (only same-package subclasses, exhaustiveness-bound)
vs. *closed* (no subclasses, plain `class`).

### 5. Discriminated-union enums (lands #725)

A `enum` whose body contains at least one payload-bearing case is
parsed as a discriminated union. The parser desugars

```gsharp
enum Shape {
    Circle(r float64);
    Square(s float64)
}
```

into

```gsharp
sealed class Shape { }
class Circle(r float64) : Shape { }
class Square(s float64) : Shape { }
```

at parse time. The desugaring is structural: case-class declarations
are appended to the surrounding member list via the parser's
`pendingSyntheticMembers` queue, so they bind, emit, and exhaustiveness-
check using the sealed-class machinery from §4 above. Construction is
plain class instantiation (`Circle(2.0)`), pattern matching uses the
`case x is Circle:` arm, and the `switch` arm-coverage check honours
the sealed-hierarchy exhaustiveness rule.

This unifies the implementation of #725 with #718 — there is no
separate discriminated-union backend.

### 6. `type` keyword retained for non-aggregates

The `type` keyword is **not** deleted from the lexer. It is retained
for type aliases (`type Count = int32`) and named delegates
(`type Greeter = delegate func(name string)`), where the head reads
naturally and there is no aggregate keyword to take its place. The
`type` keyword is rejected only when followed by an aggregate keyword
(`class`, `struct`, `enum`, `interface`) — that combination triggers
the GS0306 migration diagnostic.

### 7. Hard-removal — no deprecation window

This is a breaking change. Per the issue #718 plan §3, the migration
window is zero: the legacy `type Name <kind>` head and the `record`
keyword are rejected at parse time with the diagnostics catalogued
below. The samples, tests, and documentation have been migrated in
this PR.

### 8. Diagnostic catalogue

| Code | When emitted |
|---|---|
| GS0306 | `type Foo class` (legacy aggregate head) → "drop `type` — write `class Foo`" |
| GS0307 | `record Foo` keyword used → "the `record` keyword has been removed; use `data struct Foo` (or `data class Foo`)" |
| GS0308 | `inline class Foo` → "`inline` is only legal on `struct`" |
| GS0309 | `open struct Foo` / `open enum Foo` / `open interface Foo` → "`open` is only legal on `class`" |
| GS0310 | `sealed struct Foo` / `sealed enum Foo` → "`sealed` is only legal on `class` and `interface`" |
| GS0311 | `data inline struct Foo` → "`data` and `inline` are mutually exclusive" |
| GS0312 | `open sealed class Foo` → "`open` and `sealed` are mutually exclusive" |
| GS0313 | non-exhaustive `switch` over a sealed-hierarchy base or discriminated-union enum (warning) |

## Consequences

### Positive

- Single, uniform declaration head for every nominal aggregate.
- One extension point — modifier slots between visibility and kind — for
  every future combination (`pure`, `value`, `async`, etc.).
- `record` is no longer a separate keyword; the cognitive load of
  "record vs. data struct" disappears.
- Discriminated-union enums (#725) reuse the sealed-class machinery —
  no separate backend, no new `BoundNodeKind`.
- Aligns with Kotlin and Swift, the two languages whose surface G# now
  most closely resembles after Phase 9.
- Diagnostics GS0306 and GS0307 guide migration with the exact
  replacement spelling.

### Negative

- Hard break — every existing `.gs` source file must be migrated. The
  migration is mechanical (script in `tmp-scratch/migrate.py` during
  this PR; not committed) but every external consumer must run it.
- One additional parser pass to detect the aggregate keyword after the
  modifier list. The cost is negligible.
- Discriminated-union enums lose the per-case ordinal that flat enums
  carry. This is intentional — a DU is a closed type hierarchy, not a
  numbered enumeration. Code that needs both should use a flat enum
  for the tag and a separate value type for the payload.

## Supersession

- **ADR-0029 — record / synthesized members.** Fully superseded. The
  synthesis pipeline (equality, `with`-copy, deconstruction) lives on
  unchanged; only the spelling is renamed (`record` → `data struct` /
  `data class`).
- **ADR-0033 — inline value classes.** Partially superseded. The
  semantics of `inline struct` are unchanged from ADR-0033; only the
  declaration head is updated (no `type` keyword).
- **ADR-0017 — method virtuality.** Partially superseded. The
  `open`/`override`/`final` machinery is unchanged; the declaration
  head section is updated (`open class Foo` replaces
  `type Foo open class`).
- **ADR-0018 — interface defaults.** Partially superseded. Interface
  default-method semantics are unchanged; the declaration head section
  is updated (`interface Foo` replaces `type Foo interface`).

## Migration

All samples, tutorials, guides, and test fixtures in this repository
have been migrated to the new grammar. External consumers can use the
`tmp-scratch/migrate.py` script developed in this PR (not committed)
to mechanically rewrite `.gs`, `.cs`, and `.md` files. The pattern is:

```
type Name kind ...   →   kind Name ...
record Name ...      →   data struct Name ...
```

with `kind ∈ {class, struct, enum, interface}`. Type aliases and named
delegates (`type Count = int32`, `type F = delegate func(...)`) are
untouched.

## Notes

- The implementation reuses the existing `StructDeclarationSyntax`
  node for both `class` and `struct` aggregates (the kind is read from
  `StructKeyword.Kind`). The bound tree keeps the two as a single
  `StructSymbol` discriminated by `IsClass` / `IsSealedHierarchy` /
  `IsInline` / `IsRecord` flags. No new `BoundNodeKind` was needed.
- The Parser stages discriminated-union case-class siblings via a
  `pendingSyntheticMembers` queue drained by `ParseMembers` after each
  `ParseMember` call. This keeps the desugaring local to the parser
  and avoids any binder-level awareness of "this came from an enum
  body".
- Goldens for new samples (`Sealed.gs`, `DataStruct.gs`,
  `InlineStruct.gs`, `DiscriminatedUnion.gs`) plus refreshed entries
  in `test/Core.Tests/Baselines/refactoring-baseline.json` are included
  in this PR.
