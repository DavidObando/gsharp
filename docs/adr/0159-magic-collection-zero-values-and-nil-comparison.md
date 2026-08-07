# ADR-0159: Sound zero values and nil comparison for the magic collection types

- **Status**: Accepted
- **Date**: 2026-08-06
- **Phase**: Language semantics
- **Related**: #3310, #2262, #3163; ADR-0001 (null model), ADR-0008 (variable bindings), ADR-0016 (slices), ADR-0022 (channels), ADR-0040 (sequences), ADR-0100 (`default` expression), ADR-0104 (`?` spelling discipline, unchanged)

## Context

G#'s compiler-known ("magic") collection types are all backed by CLR reference
types: `map[K, V]` by `Dictionary<K, V>`, `[]T` and `[N]T` by `T[]`, `chan T`
by `System.Threading.Channels.Channel<T>`, `sequence[T]` by `IEnumerable<T>`,
`asyncSequence[T]` by `IAsyncEnumerable<T>`. Two long-standing unsoundnesses
follow from that representation:

1. **The zero value lied.** ADR-0008 lets a `var` declaration omit its
   initializer when a type clause is present — "the variable takes that type's
   default (zero) value". For the magic collection types that zero value was a
   **null reference**, even though the bare (non-`?`) spelling promises
   non-null (ADR-0104: `map[K, V]?` is the only nil-able spelling). The result
   was #2262: `var numbers map[int, long]` followed by `numbers[i] = …` threw
   an unguarded `NullReferenceException` — a value the type system said could
   not be nil, was.
2. **Nil comparison was patchy.** `x == nil` / `x != nil` bound for the
   reference-shaped family grown case by case (#796 functions/sequences,
   #2300 interfaces, #2354 classes, #3089 `object`, #3303/#3309 maps), but
   slices and channels still rejected it with GS0129 — pinned in #3309 as
   deliberate-at-the-time, awaiting exactly this decision.

### Language positioning (owner decision, #3310)

G# derives concepts from Go but **does not aim to align with Go**: the intent
is Kotlin/Swift-style semantics with Go/Python-simple syntax on the CLR, where
C# roundtripping (conceptual and binary) is first-class. Go keeps nil maps
readable-but-not-writable because its zero values must be allocation-free;
**allocation-free zero values are explicitly not a G# constraint**. A bare
non-`?` type that can silently hold null is precisely the Kotlin/Swift failure
mode this language set out to remove, so the fix is to make the promise true
(approach A: sound empty-instance zero values), not to re-teach users Go's nil
semantics.

## Decision

### Per-kind decision table

| Kind | CLR backing | Reference-backed | `== nil` / `!= nil` | Zero value of a declared-without-initializer slot |
| --- | --- | --- | --- | --- |
| `map[K, V]` | `Dictionary<K, V>` | yes | binds (since #3309) | **empty map** (`new Dictionary<K, V>()`) — new here |
| `[]T` | `T[]` | yes | **binds — new here** (flips #3309's pin) | **empty slice** (`new T[0]`) — new here |
| `[N]T` | `T[]` | yes | **binds — new here** | **zeroed array of length N** (`new T[N]`) — new here |
| `chan T` | `Channel<T>` | yes | **binds — new here** (flips #3309's pin) | **carved out — no auto-creation; GS0520 requires an explicit initializer** |
| `sequence[T]` | `IEnumerable<T>` | yes | binds (since #796) | **empty sequence** (an empty `T[]` as `IEnumerable<T>`) — new here |
| `asyncSequence[T]` | `IAsyncEnumerable<T>` | yes | binds (since #796) | n/a — not a declarable slot type (GS0113); exists only in async-func return position (ADR-0041) |
| function / delegate types | `MulticastDelegate` | yes | binds (since #796) | unchanged (null) — there is no canonical empty function; out of this ADR's scope |
| tuple | `ValueTuple<…>` | no (value) | n/a | all-zero value (unchanged) |
| classes / interfaces / imported refs | reference | yes | binds (#2354 / #2300) | unchanged (null) — construction is an explicit obligation |

### Nil comparison: one rule, stated once

`x == nil` / `x != nil` binds for **every reference-backed builtin type**.
`SliceTypeSymbol`, `ChannelTypeSymbol`, and `ArrayTypeSymbol` join
`BoundBinaryOperator.IsNullCompare`'s reference-shaped family alongside the
existing function/delegate/sequence/map/interface/class arms. Both operators,
both operand orders (#3217 nil-on-left canonicalization), `?`-typed and bare
operands. The emitter's generic `ldnull; ceq` tail is verifier-clean for all
of them, including the open (null-`ClrType`) generic shapes.

**Comparison-only, exactly as #796 and #3309 chose**: nil *assignment* into a
bare slot still requires the explicit `?` spelling. ADR-0104's discipline is
unchanged by this ADR.

With sound zero values, `x == nil` on a *bare* map/slice/array slot that was
never touched by interop is statically false. A "comparison is always false"
warning has no precedent in the current diagnostic set (no always-true/false
comparison analysis exists), so it is **not** implemented here; noted as a
follow-up candidate.

### Zero values: empty instances at every declaration surface

A declared-without-initializer slot of type `map[K, V]`, `[]T`, `[N]T`, or
`sequence[T]` binds an **empty instance** instead of null:

- **Locals** — `var m map[int, long]` binds `map[int, long]{}` (the #2262
  repro simply works).
- **Globals, including REPL hoisted fields** — top-level declarations flow
  through the same binder path and store the empty instance into the hoisted
  static field.
- **Struct/class fields (instance and `shared` static)** — an initializer-less
  field of these types receives a synthesized field initializer, injected
  through the existing #640/#1070 field-initializer machinery into every
  constructor (instance) or the `.cctor` (static).

Generic contexts are first-class: the synthesized initializers reuse the
existing literal machinery — the #1481/#3306 symbolic `Dictionary`2` ctor
MemberRefs for open `map[K, V]`, and the symbolic `newarr` element-type token
for open `[]T` — so `map[K, V]` / `[]K` fields of generic types get sound
zero values too.

The `sequence[T]` zero value is an empty `T[]` held as `IEnumerable<T>`. To
make that (and the user-written `q = []K{}` equivalent) bind in open-generic
contexts, `Conversion.Classify` and the emitter's `IsReferenceCompatible` gain
the symbolic same-element `[]T → sequence[T]` arm (the #3309 pattern: the
monomorphic conversion already worked through the CLR-backed rules; only the
null-`ClrType` shape was missing).

### Channel carve-out (GS0520)

An auto-created channel has no sensible default: buffer size (bounded vs
unbounded) and ownership are semantic decisions that `make(chan T[, cap])`
exists to force. `chan T` is therefore **not** auto-created. Because the
language currently has **no** general definite-assignment analysis for locals
(the only must-assign dataflow is the ADR-0060 `out`/`ref` analyzer, GS0238/
GS0239 — verified: a bare channel local declaration compiles and NREs on use
on main), soundness is enforced at the declaration site instead:

> **GS0520** (error): a `chan T` local, global, or field declared without an
> initializer must be initialized explicitly (e.g. `make(chan T)` or
> `make(chan T, capacity)`).

This is deliberately stricter than Go (declare-then-assign-later of a bare
channel slot is rejected). Two relaxations are recorded as follow-ups, not
implemented: (a) a real definite-assignment analysis for locals would allow
declare-then-assign; (b) a nullable-channel spelling — maps have `map[K, V]?`
(ADR-0104) and slices have `[]?T`, but `chan int32?` parses with the `?`
bound to the **element** (`chan (int32?)`) and `(chan int32)?` does not
parse, so the `?` escape hatch is **not currently expressible for channels**
(the spec grammar's `'chan' TypeClause '?'?` outer marker is unreachable
behind the greedy element TypeClause). A `chan?` or parenthesized type
clause is the natural future fix.

> **Addendum (2026-08, issue #3315):** follow-up (b) is implemented via
> parenthesized type clauses. A parenthesized single type clause `(T)` is
> grouping, and its trailing `?` marks the **whole** inner type nullable:
> `(chan int32)?` is a nullable channel of `int32`, satisfying GS0520's
> optional-channel escape hatch (the slot's zero value is nil, `make(chan
> int32)` assigns into it, and nil comparison / `?`-flow apply). The
> element-binding of an unparenthesized trailing `?` is **kept** —
> `chan int32?` remains `chan (int32?)` — because that is the suffix-family
> rule for open-tailed composite types (`[]T?` is element-nullable per
> #1212 and `(T) -> R?` is return-nullable per ADR-0075/ADR-0137, each with
> an explicit whole-type spelling: `[]?T` and `((T) -> R)?` respectively).
> The spec grammar's unreachable `'chan' TypeClause '?'?` outer marker is
> replaced by `'chan' TypeClause` plus the general
> `'(' TypeClause ')' '?'?` grouping production, which also gives `([]T)?`
> (≡ `[]?T`) and `(map[K, V])?` (≡ `map[K, V]?`) for free. The statically-
> false nil-compare warning follow-up is implemented as GS0523 (issue
> #3317; renumbered from an initially-assigned GS0521 to avoid a collision
> with the unrelated `PointerGenericTypeArgument` diagnostic).

### Honesty clauses (explicit limitations)

- **Element defaults stay CLR defaults.** Array/slice *elements* of map (or
  other collection) type — e.g. `[]map[K, V]` after allocation — remain null.
  Auto-filling elements is neither feasible (allocation per element on every
  `newarr`) nor precedented: this is exactly C# NRT's known array hole
  (`new string[10]` under NRT). Reading such an element and dereferencing it
  is pre-existing behavior, not a regression from this change.
- **Value-struct default instances.** `var s S` for a value `struct S` with a
  map field binds the struct's all-zero value (`initobj`), which bypasses
  constructors and therefore the injected field initializers — the field is
  null there, mirroring C#'s `default(T)` struct hole (see ADR-0155's struct
  annotation rule). Literal- and constructor-built instances (`S{}`, `S(…)`)
  do run the injected initializers.
- **The explicit `default` spelling keeps its CLR meaning.** `var m map[K, V]
  = default` (ADR-0100) still materializes the CLR default — null — like
  `default(T)` in C#. The empty-instance rule applies to *omitted*
  initializers only. Likewise, a map index-read miss still yields the
  CLR/Go-style zero of the *value* type unchanged.
- **Bare `= {}` (the #2262 parser note).** `var m map[int, long] = {}` still
  reports GS0005: G# has no target-typed composite literal; the empty literal
  spelling is `map[int, long]{}` (which parses fine, including `map[K, V]{}`).
  Target-typed `{}` is a separate language-surface decision, out of scope.

## Consequences

- #2262's NRE class is gone: bare map/slice/array/sequence slots are
  immediately usable, and the bare spelling's non-null promise is true at
  every declaration surface (locals, globals, REPL cells, class fields —
  modulo the honesty clauses above).
- Declaring a collection without an initializer now allocates. That is the
  approach-A trade the owner accepted explicitly (Kotlin/Swift semantics over
  Go's allocation-free zeros).
- Nil comparison is uniform across all reference-backed builtin types; the
  #3309 deliberate-rejection pins for slices and channels flip to positive
  witnesses. Interop-boundary and `?`-typed values remain the comparison's
  real use case.
- Bare `chan T` declarations that previously compiled (and NRE'd on use) now
  report GS0520 — a breaking change that converts a guaranteed runtime crash
  into a compile-time error with an explicit remedy.
- Follow-up candidates recorded: statically-false nil-compare warning;
  definite-assignment relaxation for channel locals; a nullable spelling for
  composite types (parenthesized type clauses); target-typed `{}` literals.

## Alternatives considered

- **Go alignment (nil maps readable, panic on write; nil slices appendable).**
  Rejected by owner decision: G# does not aim for Go semantics, and Go's
  rationale (allocation-free zeros) is not a G# constraint. It also cannot be
  reconciled with the bare/`?` nullability split — a readable-nil map is
  precisely a null in a non-`?` slot.
- **Definite assignment instead of empty instances (approach B).** Requires a
  full dataflow analysis over locals *and* an initialization protocol for
  fields/globals; turns today's working `var m map[K, V]` pattern into an
  error everywhere. Kept only as the (future) relaxation mechanism for the
  channel carve-out.
- **Auto-creating channels (`Channel.CreateUnbounded<T>()`).** An unbounded
  channel is a policy decision (unbounded growth, no backpressure) silently
  taken on the user's behalf; rejected in the issue.
- **Warning-only (keep null, warn on use).** Leaves the type system lying;
  rejected with approach A's acceptance.
