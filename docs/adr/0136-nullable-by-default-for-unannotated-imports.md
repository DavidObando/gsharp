# ADR-0136: Unannotated imported reference types are nullable by default

- **Status**: Accepted
- **Date**: 2026-07-04
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0001 (nullable types `T?`), issues [#1354](https://github.com/DavidObando/gsharp/issues/1354), [#914](https://github.com/DavidObando/gsharp/issues/914), [#1333](https://github.com/DavidObando/gsharp/issues/1333) and PRs [#1349](https://github.com/DavidObando/gsharp/pull/1349), [#1374](https://github.com/DavidObando/gsharp/pull/1374)

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

The rule is applied uniformly in all three reading paths:

- `ApplyReferenceNullabilityFull` — top-level field / property / parameter /
  return reading (previously keyed off `topFlag == 2`).
- `SymbolFromFlagsOffset` — inner generic-argument positions used by `for`-range
  and CLR indexer access (previously keyed off `flag == 2`, defaulting
  beyond-length positions to `0`). Beyond-length handling now follows the same
  rule: length-1 flags apply `flags[0]` to all positions, empty flags are
  nullable, otherwise index directly.
- `NullableFlagsBuilder.MergeDeclarationNullability` — the receiver-substituting
  path (issue #3705 family 2), which folds a declaration's flags back onto a type
  recovered by generic substitution. It reaches imported fields, constrained
  calls, `Deconstruct` out-parameters and event handler types.

`IsFlagNonNull(byte)` is the single predicate all three defer to. It exists
because the two open-codings of this one-line rule are what let the paths drift:
C# reads "nullable iff the byte is `2`", G# reads "non-null iff the byte is `1`",
and the two agree on `1` and `2` while disagreeing on `0` and on absence. A
reader that spells the rule itself will sooner or later spell C#'s.

#### The scope of "reference position": open type parameters are excluded

The rule above is about **concrete** reference positions. An **open type-parameter**
position is not one, and issue #3705 family 2 makes that explicit after a first
attempt at uniformity made `map[K, V].Keys` iterate as `K?`:

- A type parameter's nullability arrives with the type **argument** at
  substitution, and the argument carries its own annotation. Applying the
  declaration's *missing* byte overwrites the caller's answer with a guess.
- It is unsound in a way the concrete case is not. An unconstrained `K` may be
  substituted with a **value type**, where `K?` silently means `Nullable<K>` and
  changes the contract.

So an open parameter slot keeps the pre-#1354 reading: widen only for an
explicit `[Nullable(2)]`, which is the declarer genuinely writing `K?`. Absent
and oblivious leave the projected type alone.

This distinction needs care because `ExpandNullableFlags` fills absent positions
with `2` — that fill *is* the rule above — so the expanded array cannot tell
"declared `T?`" from "declared nothing". The `absentFill` overload gives the
literal reading; only the type-parameter arm uses it.

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

### 4. Call-site return-type nullability (imported method calls)

The new reading rule reached imported **fields**, **properties**, **parameters**,
and the return of **static** method calls (the latter via
`ImportedFunctionSymbol.Type`, which already routes through `ClrNullability`).
It did **not** reach imported **instance** method-call result types: the
instance-call return-type resolution in `ExpressionBinder.Calls` ended in a
fallback chain whose terminal arm mapped the CLR return type with a bare
`TypeSymbol.FromClrType(method.ReturnType)` / `MapClrMemberType(method.ReturnType)`,
bypassing `ClrNullability` entirely. For a non-generic instance method such as
`Factory.Make()` returning an oblivious `Widget`, the result was a **non-null**
`Widget`, so `f.Make() == nil` was wrongly rejected with GS0129 — the exact hole
this ADR exists to close, just on the call-return path.

The fix introduces a single helper `MapClrMethodReturnType(MethodInfo method)`
(in `ExpressionBinder.Access`) that preserves the existing by-ref-return handling
(`ref T` returns still map through `ByRefTypeSymbol`) and otherwise delegates to
`ClrNullability.GetReturnTypeSymbol(method)`, so both the oblivious default and
explicit `[Nullable]` / `[NullableContext]` annotations are honored. It replaces
the terminal fallback at every imported call-return site:

- the non-generic / regular instance-call fallback (`?? MapClrMemberType(resolution.Best.ReturnType)`);
- the inherited / `base.M(...)` call fallback (`?? TypeSymbol.FromClrType(resolution.Best.ReturnType)`);
- the constraint-interface instance-call fallback (`?? MapClrMemberType(method.ReturnType)`).

The earlier arms of each chain (`ResolveImportedGenericReturnType`,
`ResolveCallReturnTypeFromSymbolicTypeArgs`, `ResolveInstanceReturnTypeFromReceiver`)
are unchanged and run first, so generic / symbolic projections still win; the new
helper only applies on the terminal, type-erased fallback. The static-call path is
untouched, so it does not double-wrap. Value-type, `void`, by-ref, and bare
generic type-parameter returns are unaffected.

A visible BCL consequence: `System.Object.ToString()` is genuinely annotated to
return `string?`, so `base.ToString()` / `obj.ToString()` on a reference receiver
now correctly bind as `string?` and must be coalesced (`?? ""`) or null-checked
before being used as a non-null `string`. Tests that previously relied on the
buggy non-null reading were updated accordingly. Coverage:
`Issue1354InstanceMethodReturnEmitTests` (annotated-nullable instance return →
compare-to-nil compiles; annotated-non-null instance return → GS0129) and the
oblivious-instance-method case via the Core.Tests oblivious fixture
(`ImportedTypeInFunctionBodyTests`, whose `ImportedGreeter.Greet` now returns
`string?`).

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

### Call-return nullability: generic-substituted returns (deferred sub-case)

The call-return fix (section 4) applies the method's own nullability on the
**terminal, type-erased** fallback — covering the common non-generic
instance-method case (`Factory.Make()`), the inherited / `base.M(...)` case, and
the constraint-interface case. When an **earlier** arm of the chain recovers a
generic / symbolic projection — `ResolveInstanceReturnTypeFromReceiver` /
`MemberLookup.MapOpenClrTypeToSymbolic` for a constructed generic return whose
type references a type parameter or same-compilation user type (e.g.
`Queue[Entry].Dequeue()` → `Entry`) — that projection wins and the **per-position
nullability of the substituted generic argument is not yet applied** on this
path. Doing so soundly requires threading the closed method's DFS nullable-flags
through the open→symbolic substitution (mapping each substituted position back to
its flag byte), which is a deeper change than this fix warrants. The common case
(a non-generic instance method returning a plain reference type) is fully fixed;
the generic-substituted-return nullability is the only remaining call-return gap
and is tracked here as best-effort follow-up.

**Resolved.** That threading is `NullableFlagsBuilder.MergeDeclarationNullability`,
which walks the open declaration's layout and the substituted symbol in lockstep
so each substituted position recovers its flag byte. Issue #3695 applied it to
fields and event handlers, #3741 (issue #3705 family 2) to constrained-call
returns and `Deconstruct` out-parameters, and #3705 family 2's second half to the
oblivious column: `MergeDeclarationNullability` used to return the projected type
unchanged when the declaration's flags were empty, and to key its annotation off
`flag == 2` when they were not — so a member reached through a substituting
receiver kept the pre-#1354 answer for *both* shapes of oblivious. Both are gone;
the path now defers to `IsFlagNonNull` like the other two.

`Issue3705MemberKindNullabilityDifferentialTests` is the standing gate: six
signature-position kinds × four annotation states, with the expectation computed
from the annotation state alone, so the table *is* this ADR's uniformity claim
rather than a restatement of the current implementation.
