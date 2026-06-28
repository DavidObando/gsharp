# ADR-0136: Unannotated imported reference types are nullable by default

- **Status**: Accepted
- **Date**: 2026-07-04
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0001 (nullable types `T?`), issues [#1354](https://github.com/DavidObando/gsharp/issues/1354), [#914](https://github.com/DavidObando/gsharp/issues/914), [#1333](https://github.com/DavidObando/gsharp/issues/1333) and PR [#1349](https://github.com/DavidObando/gsharp/pull/1349)

## Context

G# has Kotlin-style nullability: a non-nullable reference type `T` is guaranteed
non-null and **cannot** be compared to `nil` — doing so is the compile error
**GS0129**. Only a `T?` may be null-checked (`== nil`, `!= nil`, `case nil`).
This "nullability superpower" is only sound if the type system never silently
treats a *possibly-null* value as a non-null `T`.

Two things undermined that guarantee:

1. **PR #1349** (issue #1333) weakened the invariant by allowing `ref == nil`,
   `ref != nil`, and `case nil` against a **non-nullable** reference type `T`.
   That re-opened exactly the hole GS0129 exists to close.

2. **Imported metadata defaulted oblivious → non-null.** When reading C#
   nullable metadata (`[NullableAttribute]` / `[NullableContextAttribute]`), the
   importer treated the per-position byte `2` as nullable and **everything else**
   (`0` oblivious, `1` not-annotated, or an entirely **absent** attribute) as
   non-null `T`. So a reference type coming from an unannotated/oblivious
   assembly was imported as a non-null `T` the program could never null-check —
   even though it can absolutely be null at runtime. This is the unsound
   "platform type treated as non-null" trap that Kotlin explicitly avoids.

## Decision

Reverse PR #1349 and make **unannotated/oblivious imported reference types
nullable by default**, so the non-null guarantee is real for every reference
type the compiler admits as non-null.

### 1. Revert PR #1349

`BoundBinaryOperator.cs`, `PatternBinder.cs`, and
`MethodBodyEmitter.Operators.cs` are restored to their pre-#1349 state, and the
`Issue1333RefNullCompareTests.cs` test is removed. A `== nil` / `!= nil` /
`case nil` against a non-nullable reference type once again reports **GS0129**:

```
package p
import System.Threading.Tasks
class C { func F(t Task) bool { return t == nil } }   // GS0129 — Task is non-null
```

### 2. New import reading rule (the core change)

`ClrNullability` now reads a reference-type position at DFS index `i` against the
flags array returned by `ReadNullableFlags`, via a single shared helper
`IsPositionNonNull(ImmutableArray<byte> flags, int index)`:

| `flags` shape | Meaning | Position `i` is non-null iff |
| --- | --- | --- |
| **empty** (no `[Nullable]` and no `[NullableContext]` anywhere) | oblivious / unannotated | **never** — the position is nullable `T?` |
| **length 1** (a scalar `[Nullable(b)]` or a `[NullableContext(b)]`) | one byte applies to **every** reference position | `flags[0] == 1` |
| **length > 1** (per-position array) | one byte per reference position | `flags[i] == 1` |

The single principle: **only an explicit `1` (NotAnnotated) means non-null `T`;
`2` (Annotated), `0` (oblivious), and an absent attribute all mean nullable
`T?`.** The length-1 case fixes *scalar/context expansion*: a `[Nullable(1)]` or
`[NullableContext(1)]` makes **all** nested reference positions non-null, and a
`[Nullable(2)]` makes them all nullable — matching Roslyn's compaction.

The rule is applied uniformly in both reading paths:

- `ApplyReferenceNullabilityFull` — top-level field / property / parameter /
  return reading (previously keyed off `topFlag == 2`).
- `SymbolFromFlagsOffset` — inner generic-argument positions used by `for`-range
  and CLR indexer access (previously keyed off `flag == 2`, defaulting
  beyond-length positions to `0`). Beyond-length handling now follows the same
  rule: length-1 flags apply `flags[0]` to all positions, empty flags are
  nullable, otherwise index directly.

**Value types are unaffected.** A value-type position contributes no byte and
stays non-null; `Nullable<T>` value types are already lowered in
`TypeSymbol.FromClrType`. Only reference-type positions get the new
nullable-by-default treatment. `void`, by-ref, and pointer positions are
unaffected.

Modern .NET BCL assemblies are fully nullable-annotated (their members carry
`[NullableContext(1)]`), so annotated BCL reference types **stay non-null** under
the new rule. Only genuinely unannotated/oblivious assemblies — and oblivious
positions within otherwise-annotated assemblies — become nullable.

### 3. Emit completeness (the round-trip linchpin)

Because "absent attribute → nullable" is now the rule, the emitter must stamp
**complete** nullability metadata, or a gsc-emitted non-null reference member
would be re-imported as nullable when its assembly is referenced as metadata.
The importer's `ReadNullableFlags` fallback walks only the `DeclaringType`
chain — never the assembly — so a type-level default is required. gsc now emits,
matching the shape Roslyn produces:

1. A **type-level `[NullableContextAttribute(1)]`** on every emitted user type
   (class / struct / interface / enum / delegate). This establishes "non-null"
   as the default the importer's type-chain walk finds.
2. A per-**field** `[NullableAttribute(flags)]` whenever
   `NullableFlagsBuilder.Build(field.Type)` is non-empty **and not all-`1`**
   (i.e. it contains a `2`). All-non-null fields emit nothing and rely on the
   type-level context (the compact C# shape); a field with any nullable inner
   position (e.g. `List[string?]` → `[1, 2]`) emits the full per-field array.
3. A per-**property** `[NullableAttribute(flags)]` under the same condition,
   placed on the property row itself (properties have no return-parameter).
4. Parameters / returns keep their existing per-position `[Nullable]` /
   method-level `[NullableContext]` emit, re-verified for nullable inner
   positions.

A binder gap was fixed alongside emit: a fully-concrete closed generic over a
nullable **reference** argument (e.g. `List[string?]`) previously collapsed the
inner `string?` to `string` when projecting onto the CLR closed type, so the
emitted field/return lost its inner nullability. `BindGenericTypeClause` now
attaches the DFS nullable-flags array as a `NullabilityAnnotatedTypeSymbol` (the
same shape the importer produces) when any concrete reference argument is
nullable, so the inner `?` survives binding and is re-stamped on emit.

**Round-trip guarantee.** A G# library declaring a non-null reference
field/property, a `T?` reference field/property, and a `List[string?]`-style
field is emitted to a dll and re-loaded through the same `MetadataLoadContext`
path `ClrNullability` uses; each member re-reads with the correct nullability
(non-null stays non-null, `T?` stays nullable, inner `string?` stays nullable).
This is covered by `Issue1354NullabilityRoundTripEmitTests`.

## Consequences

- The non-null guarantee is sound again: a value the compiler admits as a
  non-null `T` is genuinely non-null, so GS0129 is meaningful and `!!` / `?.` are
  required to consume a nullable value.
- Code that referenced oblivious/unannotated assemblies and relied on the old
  oblivious→non-null default now sees `T?` and must null-check or null-forgive.
  This is the intended, safer behavior.
- gsc→gsc round-trip preserves member nullability exactly.

## Deferred (best-effort, scoped follow-up)

The must-have emit positions — type-level context, fields, properties, and
parameters/returns — are complete. The following lower-priority positions are
**not yet** stamped with per-position nullability and are tracked as follow-up:

- Base-type / implemented-interface generic-argument nullability.
- Generic-constraint nullability.

These affect only the nullability of generic arguments appearing in a type's
base/interface list or constraints; the common member-signature surface
round-trips correctly today.
