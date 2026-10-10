# ADR-0199: `data class` / `data struct` synthesize the C# record ABI

- **Status**: Proposed (flips to Accepted on merge; owner direction approved
  October 9, 2026)
- **Date**: 2026-10-09
- **Phase**: Self-hosting Phase 0 — migrated-Core ABI parity
- **Supersedes**: the record-ABI parts of
  [ADR-0029](0029-data-struct-synthesized-members.md) and its 2026-10-07
  amendment (#4828): the Kotlin `ToString` format, the
  `@__Cs2GsRecordProvenance_4828` provenance split, and the "no
  `IEquatable<T>`" deferral. ADR-0029's equality, hash, `Deconstruct`,
  zero-field, `ToString`-override (#2361) and inherited-equality contracts are
  retained.
- **Related**: ADR-0025, ADR-0032, ADR-0078 (declaration head), ADR-0115
  (cs2gs), ADR-0146 (`data object`), ADR-0154 (discriminating tests),
  ADR-0157 (REPL value display); issues #3501, #4675, #4765, #4767, #4828;
  PRs #4654 (Core public-API snapshot), #4715, #4829

## Context

cs2gs translates C# `record` / `record struct` to `data class` / `data struct`.
To make the migrated `GSharp.Core` ABI-identical to the C# build, #4828
introduced a second, hidden ABI: cs2gs tags every translated record with the
compiler-intrinsic `@__Cs2GsRecordProvenance_4828`, and gsc synthesizes a
slightly different member set for tagged types. The owner has decided this is
the wrong shape for a language change that is still cheap (G# record usage is
low): **a native G# `data` type should simply be what a C# record is**, with
no marker, so cs2gs output and hand-written G# are the same thing. The marker
is also a readability cost: 190 occurrences in the migrated tree, counted by
the readability gate as an unknown synthetic family.

### Audit: what the marker actually changes today

Reading `DeclarationBinder.Attributes.cs` (`IsCSharpRecordAnnotation`) and
`TypeMemberModel` (`IsTranslatedCSharpRecord`) shows a single consumer: the
marker only suppresses `Deconstruct` for a **body-only** record (no primary
constructor), where the native G# rule would deconstruct fields and
auto-properties in declaration order. Every other #4828 behavior is already
unconditional for all data types after #4829: primary-only data-class
constructor, `left`/`right` operator names, `original` copy-constructor
parameter, sealed-owner override finality. So "merging the two ABIs" is
smaller than it sounds. The remaining real gaps against Roslyn are the
`ToString` format, `PrintMembers`, `IEquatable<T>`, and the Core snapshot
allowance below.

Two further facts from the audit. First, gsc does not synthesize
`PrintMembers` today: for open or derived records (the ones where it is
`protected` and therefore in the snapshot, 11 entries in the DocInline family
and its base) cs2gs emits it as ordinary G# source
(`CreateRecordPrintMembers` in `CSharpToGSharpTranslator.Declarations.cs`),
and the interface list is likewise carried over from the C# symbol. Moving both
into gsc lets that translator code go. Second, the migrated tree therefore
already matches on those members; the stage-2 change must keep that true.

## Decision

1. **Remove the marker.** cs2gs stops emitting `@__Cs2GsRecordProvenance_4828`;
   gsc stops recognizing it (the name becomes an ordinary unknown annotation).
   Clean break; no compatibility shim.
2. **One ABI.** Every `data class` / `data struct`, however declared,
   synthesizes the C# record ABI described in the tables below.
3. **`ToString` adopts the C# record format** (rules below), replacing the
   Kotlin form `Name(F=v)`.
4. **Keep G#'s `Deconstruct`** exactly as today (positional components when a
   primary constructor exists, otherwise fields then auto-properties in
   declaration order; skipped when there are no members). The consequence for
   the native-vs-migrated Core comparison is handled under "Core ABI snapshot".
5. **Keep** the protected/private copy constructor with parameter `original`,
   `<Clone>$`, `EqualityContract`, the virtual `Equals(T)` machinery of the
   2026-10-04 amendment, `left` / `right` operator parameter names, and
   Roslyn's finality model for object overrides (virtual, not `final`, when the
   owner is sealed; unchanged from ADR-0017 and the 2026-10-07 amendment).
6. **Add** `IEquatable<Self>` to every data type's interface list (it is
   implemented by the existing `Equals(Self)` slot), and a C#-shaped
   `PrintMembers`.
7. **Parameterless constructor: no removal** (audit below): `with` does not use it, but body-only construction and imported body-only records do.

### Member tables

"Today" is the non-tagged native behavior; cells say `=` where the member is
unchanged. `T` is the type; `B` its direct data base.

**data class**

Four class shapes have distinct ABIs. "Root" means the direct base is not a
data type; "derived" means it is one. "Today" columns are omitted where the
member is unchanged (`=`); changes are called out in the last column.

| Member | Sealed root | Sealed derived | Open root | Open derived | Change |
|---|---|---|---|---|---|
| Primary ctor | public | public | public | public | = (primary-only: no parameterless, #4829) |
| Parameterless ctor | body-only / explicit `init` only | same | same | same | = (audit) |
| Copy ctor `.ctor(T original)` | private | private | protected | protected | = |
| Copy ctor base chain | `object` | base copy ctor | `object` | base copy ctor | = |
| `<Clone>$()` | public | public virtual newslot, MethodImpl to base | public virtual newslot | public virtual newslot, MethodImpl to base | = |
| `EqualityContract` | private | protected virtual override | protected virtual newslot | protected virtual override | = |
| `Equals(object)` | public virtual override | same | same | same | = |
| `Equals(T)` | public | public sealed; plus `public sealed override Equals(B)` | public virtual | public virtual; plus `public sealed override Equals(B)` | = |
| `GetHashCode()` | public virtual override | same | same | same | = |
| `ToString()` | public virtual override | same | same | same | format becomes record format |
| `PrintMembers(StringBuilder)` | private bool | protected virtual override | protected virtual | protected virtual override | new (today cs2gs source for protected cases) |
| `op_Equality` / `op_Inequality` | public static (`left`, `right`) | same | same | same | = |
| `Deconstruct(out ...)` | per G# rule | same | same | same | = |
| `IEquatable<T>` | implemented | implemented | implemented | implemented | now always (was only when declared) |

The native `DocInline+Code` entry in the Core snapshot is the witness for the
"sealed derived" column and `DocInline` for "open root"; stage 2 adds Roslyn
witness tests for each of the four shapes rather than trusting this table.

**data struct**

| Member | Today | After |
|---|---|---|
| Primary ctor | public | = |
| `Equals(object)` / `Equals(T)` / `GetHashCode` | public (object overrides virtual, not final) | = |
| `ToString()` | public override, Kotlin format | public override, record format |
| `PrintMembers(StringBuilder)` | absent | private bool |
| `op_Equality` / `op_Inequality` | public static | = |
| `Deconstruct` | per G# rule | = |
| `IEquatable<T>` | only when declared | always |
| copy ctor, `<Clone>$`, `EqualityContract` | none (value copy) | none, as in C# `record struct` |

**Shape cases**

- *Positional* (`data class P(X int32, Y int32)`): `Deconstruct(out X, out Y)`
  (identical to C#); `PrintMembers` prints X then Y.
- *Body-only* (`data class P { X int32; Y int32 }`): parameterless ctor,
  `Deconstruct` over fields and auto-properties (G# behavior, kept; this is the
  only difference from a C# record, see snapshot section), `PrintMembers`
  prints public instance fields and readable properties in declaration order.
- *Positional plus body members*: `Deconstruct` covers the primary-constructor
  components only; `PrintMembers` covers all printable members.
- *Empty* (`data class E()` / `data struct E {}`): no `Deconstruct`;
  `PrintMembers` returns `false`; `ToString` is `E { }`. Hash stays the FNV-1a
  type-name constant of ADR-0029's 2026-07-20 amendment.
- *Generic*: unchanged from the 2026-10-04 amendment; `ToString` prints the
  simple type name without type arguments, as Roslyn does.
- *Inheritance*: `PrintMembers` of a derived record calls the base
  `PrintMembers` first and writes `", "` only if the base printed something;
  `ToString` uses the declaring (runtime-most-derived override's) own type
  name. An abstract data class does not emit a `<Clone>$` body, as today.
- *User `ToString`* (ADR-0029 2026-07-15): still allowed under the shape check;
  it replaces the synthesized `ToString` only, `PrintMembers` is still emitted.
- *User `PrintMembers`*: `PrintMembers` is not a reserved name today (cs2gs
  currently synthesizes it as ordinary source). C# allows a hand-written
  `PrintMembers`, so a user-declared `PrintMembers(StringBuilder)` of the
  compatible shape (instance, returns `bool`, accessibility per the table)
  replaces the synthesized one, exactly like the #2361 `ToString` rule; an
  incompatible shape is a diagnostic. Stage 2 picks the diagnostic id.

### `ToString` format rules

Byte-for-byte what Roslyn emits for the same record, established in stage 2 by
Roslyn-compiled witnesses (output and IL shape) rather than by this prose; the
rules below are the intended outcome and the witnesses win on any discrepancy.

- `ToString()` builds a `StringBuilder`: type name, `" { "`, then
  `PrintMembers`; if it returned `true`, append `" "`; append `"}"`.
  Examples: `Point { X = 3, Y = 4 }`, `Empty { }`.
- `PrintMembers` writes `Name = value` for each printable member, separated by
  `", "`. Printable members are non-static public fields and public readable,
  non-indexer properties declared by the type, in declaration order. Private
  members still participate in equality and hashing but no longer in the text
  (ADR-0029 said otherwise).
- Reference-typed members are appended as `object` (null prints nothing, e.g.
  `Name = `); value-typed members use their `ToString()` (current culture, as
  in C#; ADR-0029's invariant culture is dropped for parity).
- Inherited members come from the base `PrintMembers` call, not from re-reading
  base fields (today's synthesized `ToString` omits inherited fields).
- A `data struct` prints the same way (`private bool PrintMembers`).
- There is no second formatting implementation to change: the tree-walking
  interpreter is retired (ADR-0156; `StructValue` survives only for layout
  sizing), and REPL display (ADR-0157) already defers to a real `ToString`
  override, so it picks up the synthesized one. Only expectations are
  regenerated.
- `data object` (ADR-0146): C# anonymous types print `{ X = 1, Y = 2 }` with no
  type name. A field-only `data object` therefore omits its synthesized name
  and prints `{ X = 1, Y = 2 }`. This updates ADR-0146 item 6.
- `inline struct` (ADR-0033) is not a data type and is unchanged
  (`UserId(value=u-1)`).

### Parameterless constructor audit (owner's claim verified, with one correction)

`with` / `.copy(...)` on a data **class** lowers to
`EmitStructLiteral(CopySource != null)`: evaluate the source, `callvirt
<Clone>$`, then store the overrides. `<Clone>$` does `newobj` of the copy
constructor. The parameterless constructor is not involved; the owner's claim
holds for `with`. Value-type `with` copies storage. Expression-tree lowering
also goes through `DataClassCloneMethod`.

What the parameterless constructor still does, and why it stays or goes:

1. Body-only `data class` literal construction `T{X: 1}` uses the default
   `.ctor()` (`ClassCtorHandles`), exactly as a C# body-only record has an
   implicit one. It must remain; the C# ABI has it.
2. For a `data class` with a primary constructor, #4829 already suppresses the
   public parameterless constructor (`dataPrimaryOnly` in
   `PlanClassMethods`); nothing uses it.
3. `EmitStructLiteral` has a fallback (the #2263 branch) that constructs an
   *imported* data class through `GetConstructor(Type.EmptyTypes)`. It serves
   imported **body-only** C# records, which do have a public parameterless
   constructor, as well as assemblies from older gsc. It must stay. The #2291
   positional-constructor path covers only imported records that lack a
   parameterless constructor.

So nothing is removed beyond what #4829 already removed; the owner's
recollection is right for `with`, but the parameterless constructor is not
dead code and is part of the C# ABI for body-only records.

### Migration impact (counted)

Kotlin-format expectations that change in stage 2:

- Test sources asserting `Name(F=v)` on data types: 14 files (Compiler.Tests
  Emit: Issue2443, Issue2338, Issue2363, Issue2864, DataStructSynthesizedMembers;
  Core.Tests: DataStructTests, Adr0192PartialMethodsBinderTests;
  Interpreter.Tests (emitted-code expectations): Issue2896, Adr0157 spike and
  formatter tests;
  GeneratorHost: GeneratedRegexImplementingPartTests;
  cs2gs: Issue2833RecordToStringParityTests, Issue4633TestNameParityTests;
  `Cs2Gs.Pipeline/TestParityComparison.cs`, whose #2833 normalizer that maps
  Kotlin to C# test names becomes unnecessary and is removed).
- `inline struct` expectations (samples/InlineStruct.gs and `.golden`,
  tutorial `data-and-types.md`, `InlineStructTests`) are **not** affected.
- ADR text updated: 0029 (supersession note), 0146 item 6, 0157 table row,
  0115 (marker paragraph).
- Samples declaring a data type: 13 (`samples/**/*.gs`); none carries a
  `ToString` golden, but emitted-PE hash baselines for those that change
  (new `PrintMembers`, `IEquatable`) are regenerated and reviewed.
- Website: `docs/tour/types.md` (`data object`), `docs/ref/diagnostics.md`
  (ADR-0029 contract text), `docs/ref/spec.md`; release notes carry a breaking
  `ToString` entry. Versioned docs (0.3/0.4) are snapshots and not edited.
- Runtime behavior change visible to users: `ToString`/REPL output, current
  culture formatting, no private members in text, inherited members now in
  text, `IEquatable<T>` now reflected on every data type.

### Core ABI snapshot (#4654)

The snapshot (`test/Core.Tests/Baselines/gsharp-core-public-api.txt`, 8,500
lines, 524 types) is rendered from metadata and compared by
`CorePublicApiSnapshotTests` against the native C# build; the same test
running in the migrated `Core.Tests` compares the migrated Core. Nothing
normalizes additive members.

**Affected types.** Public records in `src/Core` with a body-only shape
(no primary constructor) gain a G# `Deconstruct`, which native C# does not
have. There are ten, all `public sealed record`:
`MarshalAsMetadata` (5 members), `PInvokeMetadata` (11),
`StructLayoutMetadata` (3), `BoundFieldInitializer` (up to 5),
`BoundCatchClause` (5), `BoundSelectCase` (6), `BoundUnaryOperator` (4),
`BoundBinaryOperator` (5), `BoundAttributeArgument` (5) and `BoundMapEntry` (2).
Exact member lists are produced by the renderer in stage 2 (only auto
properties and fields participate). All other public Core records are
positional (`OptionalValue`, `TypeInfo`, `SymbolInfo`, `SymbolDisplayPart`,
`SymbolDisplayFormat`, `BoundBodyCacheKey`, the `DocInline` family,
`DocumentationComment` and its parts, `ImportedTypeAmbiguity`) and keep the
C#-identical positional `Deconstruct`. Internal and private records are not in
the snapshot. The remaining differences vanish with the marker removal itself:
`PrintMembers` and `IEquatable<T>` are already in native C# records, and the
C# snapshot already lists them.

**Options considered.**

- A. Narrow, explicit, documented allowance (**chosen by the owner**).
- B. Limit `Deconstruct` to positional components for cs2gs-migrated types.
  Rejected: re-creates a per-origin ABI, the thing this ADR removes.
- C. Normalize all additive members in the comparer. Rejected: hides real
  additions (the #4654 policy exists to expose them).

**Decision and scope of the allowance.**

- The allowance covers only the compiler-synthesized `Deconstruct` method on
  the ten body-only record types listed above. The audit found no other
  additive member. A future additive synthesized member needs its own ADR
  amendment, not a silent extension of the list. It is not a general additive
  waiver.
- It is an exact allow-list file next to the golden
  (`gsharp-core-public-api-allowed-additions.txt`): each entry names the type
  and the full rendered member line. A non-listed addition, a listed entry on a
  non-record type, a missing/changed existing line, or any material difference
  still fails.
- The comparer reports present entries in a separate "allowed additions"
  section of the test output so they stay visible in review. Native C# Core
  has none of them present and passes without them (the allowance is "may be
  present", never "must").
- Discriminating tests (ADR-0154): a non-record type gaining a public method
  fails; a record gaining a non-synthesized member fails; a record `Deconstruct`
  not in the list fails; a listed `Deconstruct` passes and is reported;
  removing an existing member fails.
- Stage 2 generates the list from the actual strict comparison run
  (build/run-cs2gs-selfmig-migrate.sh with the `api` validation), reviews each
  entry, and proves no other difference remains.

## Consequences

Positive: one ABI for cs2gs output and hand-written G#; no provenance marker
or readability-gate debt; C# interop consumers and C# `ToString` expectations
(including cs2gs test-name parity) just work; `IEquatable<T>` is visible to
generic constraints and `HashSet<T>`/`Dictionary` fast paths.

Negative: a breaking `ToString` change for all G# code that printed data types
or compared the text; slightly larger data types (`PrintMembers`, interface
row); ten public Core records carry an additive `Deconstruct` that the
snapshot must carry as an explicit exception.

## Staging

1. This ADR (docs only).
2. Implementation seams, one PR each where reviewable: (a) marker removal in
   cs2gs and gsc plus snapshot allowance and tests; cs2gs stops generating
   `PrintMembers` once gsc synthesizes it (seam b); (b) `PrintMembers`,
   record-format `ToString`, `IEquatable<T>` emit, `data object`, regenerated
   REPL expectations; (c) docs, website, release notes, golden regeneration. Proof: strict
   native-vs-migrated Core snapshot, migrated Core.Tests / Compiler.Tests /
   Cs2Gs.Tests parity for affected projects, Roslyn witness tests for
   `ToString` and metadata shape.
