# ADR-0193: Nullability queries are type-level and funnelled

- **Status**: Proposed
- **Date**: 2026-09-23
- **Phase**: Phase 9 — null model / CLR interop
- **Related**: [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md)
  (platform types `T!`, the system this ADR hardens; its text is not amended —
  it is cross-referenced throughout), [ADR-0136](0136-nullable-by-default-for-unannotated-imports.md)
  (the `--nullability=enabled` compatibility mode this ADR does not build for),
  [ADR-0001](0001-null-model.md) (the null model, including value-type
  optionality), [ADR-0132](0132-nullable-array-element-spelling.md) (`[]T?` vs
  `[]?T` — the positional rule the element-position API must preserve),
  [ADR-0115](0115-csharp-to-gsharp-migration-tool.md) (cs2gs); issues #4363 (the
  problem statement), #4361 (the latest instance), #4372 (retiring
  `--nullability=enabled`), #4287 (the carve-out saga ADR-0186 grew out of),
  #4385 (revisiting `T!` for Open question 1's cell after Phase 3);
  PR #4362 (whose round 3, commit `b0c76053d`, deferred the symbolic-return gap
  here)

## Context

### The defect class

ADR-0186 moved nullability *origin* into the type system: an oblivious position
is a `PlatformTypeSymbol` (`T!`), a stated-nullable one is a
`NullableTypeSymbol` (`T?`), a stated non-null one is bare `T`. That fixed the
question *"what is this position's nullability?"* at the level of **what the
answer is**. It did not fix it at the level of **who is allowed to compute the
answer**. The codebase still has many independently written paths that each
derive some form of that answer — from metadata bytes, from a symbolic
projection, from a wrapper-type test, from a bound-node kind — and nothing forces
a new path to consult the same source of truth as the existing ones.

The result is the single most recurring defect class of the ADR-0186 work: two
paths compute the same fact about one declaration, one of them is updated for a
new symbol shape, receiver kind or metadata pattern, and the other is not.
Issue #4363 records the pattern; the instances below are the evidence. They were
each fixed locally, usually after an automated review or a self-migration corpus
run found them, and each fix was correct. The recurrence *rate* is the signal.

### The instances

- **The #4287 carve-out.** `ExpressionBinder.CanBindClrInstanceMember` grew from
  one arm to four as each new bound-node kind carrying the same underlying fact
  (oblivious CLR nullability) was independently discovered. ADR-0186 §5 exists to
  replace it; step 4 (PR #4353) found it still carries stated-nullable chains and
  kept the disjunct.
- **`a967928a0`** — cs2gs's generic instance-call receiver branch forgot the
  null-forgiveness helper every sibling branch called.
- **`T!?` at three sites.** `?.`, `?[` and a nil switch arm independently wrapped
  a platform operand into `Nullable(Platform(U))`. It was fixed once, by
  normalising inside `NullableTypeSymbol.Get` (`src/Core/CodeAnalysis/Symbols/NullableTypeSymbol.cs`),
  whose comment states the lesson directly: *"One normalisation point is the only
  version of this that cannot drift."* It took three separate review findings to
  get there.
- **`TryGetPlatformArgumentPairs`** initially did not recognise slices, arrays and
  maps, so those shapes silently bypassed ADR-0186 §3's type-argument rule.
- **`c478e44ab`** — "§2's open-type-parameter carve-out, in the projection path":
  the projection reader (`ClrNullability.ProjectNullableFlags`) stamped an open
  declaration's byte onto the substituted argument, which the merge reader never
  did.
- **`ea81a944f`** — "an explicit byte at an open slot is not obliviousness": the
  same two readers disagreeing about a different byte value at the same
  position.
- **#4361 / PR #4362** — the projection reader gated §2 on an *explicit* `0` and
  let an *absent* byte (a `#nullable disable` or netstandard2.0 assembly) fall
  through to its own `0` fill, stamping `T!` onto every open slot of an
  unannotated generic. The merge reader already had the right rule (*"Absent and
  oblivious leave it alone"*). The comment now at `ClrNullability.cs` ~line 1045
  names the cause: *"the projection path no longer disagrees with its sibling
  about the same declaration."* This took `main`'s nightly self-migration red.
- **The symbolic-return gap, still open.** PR #4362 rounds 1–2 added a
  declaration-nullability merge to
  `MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs`; round 3
  (`b0c76053d`) backed it out because every variant broke something downstream,
  for two *independent* reasons recorded in that commit:
  1. the full merge re-annotated open slots — `Min()`/`Max()` on an
     unconstrained `T` became `T?`; and
  2. even a root-only `!` broke things, because *"consumers of the symbolic
     projection (TryProjectErasedClrType, member lookup, inference, emit) do not
     peel PlatformTypeSymbol"* — `List[Func[Src, int32]]!` fell back to the
     erased `List<Func<object, int>>` (GS0159 / ilverify `StackUnexpected`), and a
     `ConvertDelegate[T]!` argument stopped inferring `T`.

  #4361 is closed, but this portion was explicitly deferred to #4363. On `main`
  today (`src/Core/CodeAnalysis/Binding/MemberLookup.cs:1641`) the path maps the
  open return with `MapOpenClrTypeToSymbolic` and returns it with no declaration
  merge, so a concrete oblivious container returned through a symbolically
  inferred generic call loses its `!`.
- **The lambda common type, found while writing this ADR.** The two-arm
  conditional (`ExpressionBinder.Operators.cs`, `UnionArmNullability`) and the
  switch expression (`ExpressionBinder.SwitchExpr.cs`, `ComputeBestCommonType`)
  both apply ADR-0186 §3's join rule — an explicit `T?` wins, a `T!` arm keeps the
  result `T!`. `LambdaBinder.ComputeLambdaCommonType` (`LambdaBinder.cs:2662`)
  has **no** platform arm; `LambdaBinder.cs` does not mention
  `PlatformTypeSymbol` at all. Whatever it produces for a `T!`/`T` return pair is
  decided by `Conversion.Classify`'s direction, not by §3. It has not been
  reduced to a failing program, and Phase 3 must do that before changing it, but
  it is the same defect class, in a fourth join, today.

### The inventory

A read-only audit enumerated every code path that answers some form of *"what is
this type's, symbol's or receiver's nullability?"*. It falls into layers. The
counts below were re-measured on `main` at `7a44ca033` for this ADR; where they
differ from the audit's own figures, the re-measured figure is used and the
difference is noted.

**Layer 0 — the byte classifier (holds).** `ClrNullability.ClassifyFlag`,
`ClassifyPosition`, `SymbolForState` and the private `DefaultAbsentFill`
(`src/Core/CodeAnalysis/Symbols/ClrNullability.cs`), over the three-valued
`ClrNullabilityState` enum (`Oblivious`, `NotAnnotated`, `Annotated`). No drift
has been found here. One convention violation:
`ConversionClassifier.PreserveParameterTopLevelNullability`
(`src/Core/CodeAnalysis/Binding/ConversionClassifier.cs:3176`) compares
`flags[0] == NullableFlagsBuilder.Annotated` by hand instead of classifying.
`SymbolForState` also carries this layer's only dual-mode branch
(`NullabilityOptions.PlatformTypesEnabled ? Platform : Nullable`).

**Layer 1 — metadata-structure walkers (has drifted three times).** Three
independent walkers map a flag array onto a type's structure — the direct reader
(`ClrNullability.SymbolFromFlagsOffset`), the projection reader
(`ClrNullability.ProjectNullableFlags`), and the merge
(`NullableFlagsBuilder.MergeDeclarationNullability` in
`src/Core/CodeAnalysis/Emit/NullableFlagsBuilder.cs`) — plus a lazy accessor
(`NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol` /
`GetTypeArgumentSymbolForClrType`). `c478e44ab`, `ea81a944f` and #4361 are all
disagreements between two of these about one declaration. They walk physically
different inputs (a CLR `Type` alone; a closed `Type` against its open layout; a
symbol against a CLR layout), which is why they are separate — but each one
re-derives, inline, the *rule* for what a classified position becomes, and that
rule is the part that drifts.

**Layer 2 — signature-position producers.** About seven producer families turn a
member signature position into a `TypeSymbol`. Most route through the
receiver-aware `MemberLookup.GetClr*TypeSymbol` family (`GetClrPropertyTypeSymbol`,
`GetClrFieldTypeSymbol`, `GetClrEventHandlerTypeSymbol`,
`GetClrMemberDeclaringTypeSymbol`, `GetClrMethodReturnTypeSymbol`,
`GetClrMethodParameterTypeSymbol`, `MemberLookup.cs` ~4884–5214), which merge
declaration nullability correctly. Outside it:

- `ExpressionBinder.ResolveInstanceReturnTypeFromReceiver`
  (`ExpressionBinder.Calls.Invocation.cs:452`) — correct today (it calls
  `MergeDeclarationNullability`), but a fourth hand-written producer outside the
  family: drift *risk*, not drift.
- `MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs` — the open gap above.
- A pre-triage census: **43** `FromClrType(…ReturnType|ParameterType|PropertyType|FieldType|EventHandlerType)`
  calls and **63** `MapOpenClrTypeToSymbolic` calls in `src/Core` (the latter
  including those already followed by a merge). The audit's triage estimate was
  ~30 and ~35 unfunnelled respectively; Phase 2 establishes the real figures.

**Layer 3 — two representations of inner nullability.** A nested position is
either a nested wrapper (`List[string!]` is `Imported(List, [Platform(string)])`)
or a lazily-decoded byte array on a `NullabilityAnnotatedTypeSymbol`. Consumers
must know which one they are holding; `Conversion.cs`'s magic-collection element
comparison, for instance, deliberately goes through
`NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType` *because* it is
the accessor an element read uses, and would silently disagree with the read
otherwise.

**Layer 4 — consumers (the largest surface).** Measured with
`grep -rEo "(is|as) (not )?(NullableTypeSymbol|PlatformTypeSymbol|NullabilityAnnotatedTypeSymbol)\b" src/Core`:
**503 open-coded wrapper-test occurrences on 482 lines in 80 files** (418
`NullableTypeSymbol`, 53 `PlatformTypeSymbol`, 32
`NullabilityAnnotatedTypeSymbol`). That pattern only catches `is` and `as`.
A broader grep also catches:
- explicit casts, e.g. `((NullableTypeSymbol)existing).UnderlyingType` at
  `MemberLookup.cs:8035` and `(PlatformTypeSymbol)from` at `Conversion.cs:3435`
  (16 in total);
- `case` labels (52);
- switch-expression arms (25);
- `or` / `and` pattern combinators (16);
- nested property subpatterns.

With those included, the census rises to **about 586 lines in 88 files**. The
audit's figure was ~385 in 78 files; the difference comes from which forms were
counted. No grep is authoritative here. Phase 3 re-censuses with GSA0008
itself, which works on operations rather than on syntax (§3). Not every one of these is a
*reference*-nullability query — `NullableTypeSymbol` also represents value-type
optionality (`int32?` is `Nullable<int>`), and a large share of the emitter's
tests (`MethodBodyEmitter.Conversions.cs`, 34; `MethodBodyEmitter.Operators.cs`,
22) are about that. Distinguishing the two *is itself* one of the questions each
site answers by hand, with four different predicates (below).

Ten "strip nullability" helpers exist, and their semantics differ:

| Helper | Strips `T?` (ref) | Strips `T!` | Strips annotated | Strips `Nullable<V>` | Deep | Value-nullable test |
|---|---|---|---|---|---|---|
| `PlatformTypeSymbol.StripTopLevel` (shared) | no | top | no | no | no | — |
| `TypeSymbol` local `StripReferenceNullabilityCore` (TypeSymbol.cs:1316) | yes | yes | yes | no | no (loops top) | `NullableLifting.IsAnyValueTypeNullable` |
| `MethodBodyEmitter.UnwrapReferenceNullable` (Conversions.cs:850) | yes | yes | no | no | no | `ReflectionMetadataEmitter.IsValueTypeNullable` |
| `MemberLookup.StripReferenceNullableAnnotations` (7412) | yes | **no** | no | no | tuples only | `NullableLifting.IsAnyValueTypeNullable` |
| `SymbolDisplay.StripReferenceNullable` (924) | yes, one level | **no** | no | no | no | `ClrType?.IsValueType` + `StructSymbol`/`EnumSymbol` |
| `Conversion.UnwrapReferenceNullable` (2797) | yes | **no** | yes | no | no | `IsReferenceLikeTarget` |
| `Conversion.UnwrapPlatformAndNullable` (3974) | yes | yes | no | **yes** | no | none |
| `Conversion.UnwrapNullableForVariance` (4337) | yes, one level | yes | no | **yes** | no | none |
| `StatementBinder.StripNullable` (Conditionals.cs:684) | yes, one level | **no** | no | **yes** | no | none |
| `DeclarationBinder.StripPlatformOrReferenceNullable` (Functions.cs:2954) | yes, one level | yes | no | no | no | `Conversion.IsReferenceLikeTarget` |

Some of these differences are intended (a variance check genuinely wants to see
through `Nullable<V>`); most are the accident of each helper being written for
the shapes its author had in front of them. None documents which. Four joins
exist — the conditional, the switch expression, the lambda common type, and
`??` in `BoundBinaryOperator` (where PR #4362 added and then backed out a
`CoalesceResult` helper) — and, as above, they do not agree.

**Layer 5 — bound-node-kind predicates.** `CanBindClrInstanceMember`
(`ExpressionBinder.Access.MemberLookup.cs:1062`) and
`TryGetUserInstanceMemberReceiverType` (same file, ~1069) repeated the same
`receiver is BoundClrPropertyAccessExpression && receiver.Type is NullableTypeSymbol`
disjunct — the "chain through a stated-nullable property read" fact, answered by
node kind. The audit counted three such predicates; this ADR located two. The
first one's documentation also recorded a dual-mode behaviour (*"under
`--nullability=enabled` it also admits oblivious reads"*). *(Resolved by #4356:
both disjuncts are deleted, not replaced. A stated-nullable receiver now simply
fails the plain non-nullable test and requires narrowing, `!!` or `?.`, like any
`T?`; cs2gs was taught to emit those first (#4365). Both helpers are now plain
type tests with no node-kind arm, so this layer has nothing left to migrate.)*

**Layer 6 — non-metadata producers of `T!`.** Oblivious-scope binding
(ADR-0186 §9) and the joins above construct `PlatformTypeSymbol`s without any
metadata read. `PlatformTypeSymbol.Get` (`PlatformTypeSymbol.cs:94`) is
idempotent over its own wrapper but, unlike `NullableTypeSymbol.Get`, does not
normalise: `PlatformTypeSymbol.Get(NullableTypeSymbol.Get(U))` builds
`Platform(Nullable(U))`, a `T?!` that §3's principle (*an explicit statement
always beats the absence of one*) says is `T?`.

**Layer 7 — cs2gs.** cs2gs re-derives the import rule against Roslyn's
`NullableAnnotation` rather than against gsc's classifier: about 100
`NullableAnnotation` comparisons across ten translator files
(`CSharpTypeMapper.cs:443/564/613`, `CSharpToGSharpTranslator.Expressions.cs`,
`.Types.cs`, `.Nullability.cs`, `.Patterns.cs`, …). The audit described this as
"a ~1,790-line reimplementation"; that is the size of
`CSharpToGSharpTranslator.Nullability.cs`, most of which is *usage-driven
promotion* (issue #1072's `IsUsedAsNullable`, the taint queries into
`ObliviousNullabilityAnalyzer`) that has no gsc counterpart and is not the import
rule. The import-rule portion is the scattered `NullableAnnotation` → G#
spelling decisions, e.g. `IsImportedObliviousNullableTarget`'s
`declaredType.NullableAnnotation == NullableAnnotation.None` and
`CSharpTypeMapper`'s `== NullableAnnotation.Annotated` arms.

### Why case-by-case review has stopped being enough

Every instance above was *locally* correct once fixed, and several were found by
review within the PR that introduced them. The cost is the number of review
rounds (PR #4362 needed four; ADR-0186 step 5 needed eleven) and the instances
that reach `main` anyway (#4361 took the nightly red). A new path cannot be told
it is bypassing the canonical classifier, because there is no canonical
classifier above Layer 0 to bypass.

## Decision

Two choke points, each enforced by a live Roslyn analyzer, plus a test that pins
the readers to each other.

### 1. The producer choke point: `NullabilityImportRule`

A new internal static class, `NullabilityImportRule`
(`src/Core/CodeAnalysis/Symbols/NullabilityImportRule.cs`), owns the single
decision *"a position whose declaration is classified as S, substituted (or not)
with argument A, gets which reference nullability?"*.

The rule is **representation-neutral**: its core neither accepts nor returns a
`TypeSymbol`, because its two consumers use unrelated type models — gsc's
`TypeSymbol` hierarchy, and cs2gs's `GTypeReference` AST
(`tools/cs2gs/Cs2Gs.CodeModel/Ast/GTypeReference.cs`), whose printer represents
only `IsNullable` and has no platform wrapper, since `T!` is unspellable in
ordinary G# source. Each type model gets a thin *applier* over the shared
decision; the decision itself exists once.

```csharp
internal enum ImportedReferenceNullability
{
    Unchanged,   // keep the input exactly as it is, including any `?` it already carries
    NotNull,     // T
    Nullable,    // T?
    Platform,    // T!
}

// What is known about a type argument's kind at the point the rule runs.
internal enum TypeArgumentKind
{
    Reference,   // a reference type, or a type parameter constrained to one (`class`, a class type)
    Value,       // a value type, or a type parameter constrained `struct` / `unmanaged`
    Unknown,     // an unconstrained (or interface-only-constrained) type parameter
}

internal static class NullabilityImportRule
{
    // The shared decision — no type model in the signature.
    internal static ImportedReferenceNullability DecideConcrete(
        ClrNullabilityState state, TypeArgumentKind kind);
    internal static ImportedReferenceNullability DecideOpenSlot(
        ClrNullabilityState declaredState, TypeArgumentKind argumentKind);

    // gsc's applier over TypeSymbol (Core).
    internal static TypeSymbol ApplyConcrete(TypeSymbol baseSymbol, ClrNullabilityState state);
    internal static TypeSymbol ApplyOpenSlot(TypeSymbol argument, ClrNullabilityState declaredState);
}
```

- Its input is `ClrNullabilityState`, not bytes. That is what lets physically
  different readers share it: gsc's walkers reach a state through
  `ClrNullability.ClassifyFlag`/`ClassifyPosition` (unchanged, Layer 0); cs2gs
  reaches one through a thin `NullableAnnotation` → `ClrNullabilityState` adapter
  (`None` → `Oblivious`, `NotAnnotated` → `NotAnnotated`, `Annotated` →
  `Annotated`). Each side owns only its input adapter and its applier; the
  decision is shared.
- **The argument's kind is three-valued, not a boolean.** "Is this a value
  type?" has a third answer for an unconstrained type parameter: *not known*.
  Roslyn says so explicitly — an unconstrained (or interface-constrained)
  `ITypeParameterSymbol` reports both `IsReferenceType` and `IsValueType` as
  false, which `CSharpTypeMapper.cs` (~435–442) already has to special-case —
  and a boolean would silently fold that into one side; folded into
  "reference" (as `!isValueType` would), `DecideOpenSlot`
  means `Nullable` and recreates exactly the `Min()`/`Max()`-on-unconstrained-`T`
  regression PR #4362 round 1 hit. Each side's adapter classifies its argument
  into `TypeArgumentKind`; `Unknown` is never coerced to either neighbour.
- `DecideConcrete` is ADR-0186 §2's table: `NotAnnotated` → `NotNull`,
  `Annotated` → `Nullable`, `Oblivious` → `Platform`; a `Value` position is
  `Unchanged` in every row. (A concrete position's kind is always `Reference` or
  `Value` — it is a closed type, not a parameter.)
- `DecideOpenSlot` is ADR-0186 §2's carve-out plus owner decision 1 below:

  | Declared state at the open slot | `Reference` argument | `Value` argument | `Unknown` argument |
  |---|---|---|---|
  | `Annotated` (`[Nullable(2)]T`) | `Nullable` | `Unchanged` | `Unchanged` |
  | `NotAnnotated` | `Unchanged` | `Unchanged` | `Unchanged` |
  | `Oblivious` / absent | `Unchanged` | `Unchanged` | `Unchanged` |

  The `Unknown` column is `Unchanged`: the argument (a G# type parameter `T`)
  keeps whatever it already says. That is what PR #4362 round 2 did
  (`4d6001c08`, *"unconstrained T is not widened"*), and it is the only choice
  in the column that does not reintroduce the round-1 regression. (*Phase 1
  correction:* round 3, `b0c76053d`, reverted round 2's `NullableFlagsBuilder`
  guard along with the symbolic-return merge. So on `main` before Phase 1 the
  merge reader *did* widen an unconstrained `T` at an `Annotated` open slot:
  `List[T].Find` through `GetClrMethodReturnTypeSymbol` read `T?`. Phase 1
  implements the owner's `Unchanged`, which is a behaviour change on that
  path. See the Phase 1 implementation note.) It
  carries a known soundness cost, stated rather than hidden: an `Annotated`
  open slot (`TSource? Min<TSource>`) substituted with an unconstrained G# `T`
  that is later instantiated with a reference type can yield nil into a
  position typed `T`. The alternative — `Platform` for that one cell, i.e.
  "nullability not known here" — is ADR-0186's own answer for unknown
  nullability and would be checked at the coercion point, but it depends on a
  platform wrapper over a type parameter that may be instantiated with a value
  type, which Phase 1's `PlatformTypeSymbol.Get` normalisation does not yet
  define, and on symbolic-projection consumers that peel that wrapper, which
  Phase 3 adds (PR #4362's attempts without them failed with GS0159 and
  ILVerify `StackUnexpected`). This cell was the one entry in the rule that needed the repository
  owner's explicit confirmation before Phase 1 (Open question 1). **Resolved
  2026-09-24: the owner confirmed `Unchanged` as written.** Revisiting
  `Platform` for this cell is deferred until Phase 3 lands and is tracked in
  #4385, which is a Phase 3 exit criterion.
- **`Unchanged` preserves the input's own nullability, on both type models.**
  gsc's `ApplyConcrete`/`ApplyOpenSlot` map the decision onto `TypeSymbol`:
  `Unchanged` → the input symbol exactly as given (a `string?` argument stays
  `string?`), `NotNull` → the bare symbol, `Nullable` → `NullableTypeSymbol.Get`,
  `Platform` → `PlatformTypeSymbol.Get`. cs2gs's applier (created by ADR-0186 step 6, completed in Phase 5) maps it onto
  `GTypeReference`, whose only nullable state is `IsNullable`:
  - `Unchanged` → the argument's `GTypeReference` with its **existing**
    `IsNullable` preserved — substituting `string?` into an oblivious open slot
    emits `string?`, not `string`;
  - `NotNull` → `IsNullable = false` (the only arm that clears it);
  - `Nullable` → `IsNullable = true`;
  - `Platform` → `IsNullable = false`, with the position reported to cs2gs's
    existing forgiveness/bridging logic as oblivious — the same meaning,
    expressed in the only form cs2gs's output language has for it.

  The reader-agreement test (§4) and the cs2gs applier's tests (with ADR-0186 step 6, and extended in Phase 5) each include a
  `string?` argument substituted into `Annotated`, `NotAnnotated` and
  `Oblivious` open slots, asserting `string?` in all three.
- **Platform-types semantics only** (owner decision 2). There is no
  `NullabilityOptions` branch in this class, and none may be added.
  `ClrNullability.SymbolForState`'s existing dual-mode branch is left for #4372 to
  delete; until then `SymbolForState` delegates to `ApplyConcrete` under
  platform types and keeps its legacy arm for the mode being retired.
- The three Layer 1 walkers and the lazy accessor keep their structure-walking —
  it is genuinely different per input — but every one of them resolves a
  classified position by calling this class. None may construct a
  `NullableTypeSymbol` or `PlatformTypeSymbol` for a classified position itself.

### 2. The consumer choke point: a type-level query API on `TypeSymbol`

Consumers stop asking *"what wrapper is this?"* and ask *"what is this type's
reference nullability?"*. New members on `TypeSymbol`
(`src/Core/CodeAnalysis/Symbols/TypeSymbol.cs`):

| Member | Meaning |
|---|---|
| `ReferenceNullability` | `NotNull`, `Nullable` or `Platform` for the top-level position; value types (including `Nullable<V>`) report `NotApplicable` |
| `AdmitsNil` | true for `T?` (reference or value), `T!`, and the nil type — the question `== nil`, `??`, `if let` and narrowing actually ask |
| `IsStatedNullable` | true only for an explicit `T?` (reference or value) — the question ADR-0186 §3's join and the Layer 5 chain predicate ask |
| `StripReferenceNullability(bool deep)` | removes `?` (reference only), `!` and annotation wrappers; never touches `Nullable<V>`; `deep` recurses into element and type-argument positions of **both** Layer 3 representations |
| `GetElementPositions()` | the element / type-argument positions **with the nullability the reader gives them**, whichever Layer 3 representation holds them — the one accessor `Conversion`'s element comparison and an element read must both use |

- **One value-nullable predicate.** The API is implemented on
  `NullableLifting.IsAnyValueTypeNullable`, which `Conversion.cs` already calls
  *"the single seam for every `Nullable<T>` probe"*. The other three predicates in
  the helper table above (`ReflectionMetadataEmitter.IsValueTypeNullable`,
  `Conversion.IsReferenceLikeTarget` as used for this purpose, `SymbolDisplay`'s
  `ClrType?.IsValueType` test) stop being used to answer this question.
- **One join, and a separate coalesce.** They are two operations, not one
  operation called two ways. The join's "any `T!` arm keeps `T!`" is
  wrong for `??`: `T! ?? T` would keep `T!`, while ADR-0186 §6 says the result of
  `??` is non-null.
  - `TypeSymbol.JoinReferenceNullability(TypeSymbol common, IEnumerable<TypeSymbol> arms)`
    implements ADR-0186 §3's rule: an explicit `T?` arm wins outright; otherwise
    any `T!` arm keeps the result `T!`; otherwise `T`. The conditional,
    switch-expression and lambda joins call it.
  - `TypeSymbol.CoalesceReferenceNullability(TypeSymbol common, TypeSymbol originalFallback)`
    is `??`'s operation, and it encodes today's behaviour
    (`BoundBinaryOperator.cs`, the `QuestionQuestionToken` arm, as left by
    `b0c76053d` and pinned by `Issue2579`) exactly:
    1. *Before the call*, **stripped copies** of both operands are made: the
       top-level `?` (reference **or** value) and `!` are removed, using
       `StripReferenceNullability(deep: false)` plus unwrapping of a value
       `Nullable<V>`. These copies match today's `leftUnderlying` and
       `rightUnderlying`. `common` is computed **from the stripped copies** by
       the existing conversion rules: identity, then C# §12.15's best common
       type. The stripped copies are used only to compute `common`.
    2. The call receives the **original, unstripped** fallback operand type as
       `originalFallback`, just as today's code tests the original `rightType`
       (`rightType is NullableTypeSymbol`, `BoundBinaryOperator.cs:322` and
       `:363`), not `rightUnderlying`. It returns `Nullable(common)` when
       `originalFallback.IsStatedNullable` (reference or value `?`), and bare
       `common` otherwise. **A `T!` fallback yields bare `common`**, as today;
       it does not make the result `T!`. Passing the stripped fallback here
       would be a bug: it could never be stated-nullable, so `T! ?? T?` would
       wrongly become `T`.
    3. The special cases stay outside the call, unchanged: `x ?? throw e`
       yields the stripped left operand; a `nil` left operand yields the right
       operand's type.

    Whether a platform fallback *should* make the result `T!` is an open
    design question, issue #4364. This ADR does not settle it: Phase 3
    preserves the current behaviour, and if #4364 changes it, the change goes
    in `CoalesceReferenceNullability` alone. Phase 3's regression tests pin
    `T! ?? T` → `T`, `T ?? T!` → `T`, `T! ?? T?` → `T?` (the case that
    requires the original fallback), `int32? ?? int32` → `int32`, and
    `int32? ?? int32?` → `int32?`.
- **`PlatformTypeSymbol.Get` normalises** exactly as `NullableTypeSymbol.Get`
  does, in the mirror direction: `Get(Nullable(U))` returns `Nullable(U)` (an
  explicit statement beats its absence), and `Get(V)` for a value type `V`
  returns `V`. Its return type widens from `PlatformTypeSymbol` to `TypeSymbol`.
  After this, `T?!` and `T!?` are both unconstructible.
- The wrapper classes remain the *representation*; they stop being the
  *interface*. Outside the query API's own implementation, the two factories, the
  Layer 1 walkers' structure reads, and code whose job is the representation
  itself (display, signature/metadata encoding), code does not test for them.

### 3. Enforcement: analyzers, not reviews

Both choke points are enforced by live diagnostics in
`src/Analyzers/InternalAnalyzers`, following `ReflectionTypeComparisonAnalyzer.cs`
(owner decision 3). `src/Core/Core.csproj` already references that project as an
analyzer (`OutputItemType="Analyzer"`), so the rules fire in every Core build and
in the IDE.

- **GSA0007 — producer funnel.** The rule polices the **conversion doors**, not
  the arguments passed to them. An argument-shape rule — "a `FromClrType` whose
  argument is a `ReturnType`" — cannot hold across a helper boundary:
  `Read(Type t) => TypeSymbol.FromClrType(t)` has no signature accessor in it,
  and `Read(method.ReturnType)` has no conversion call in it, so both pass while
  the result bypasses the funnel. That shape already exists on `main`:
  `StatementBinder.Loops.cs:592` is a private `MapOpenClrTypeToSymbolic`
  forwarding wrapper. Following values through calls would need an
  interprocedural dataflow analysis, which an incremental Roslyn analyzer
  cannot do soundly. So the rule does not try. It reports every *call* to a
  door, whatever the argument, outside members that are declared to be the
  funnel.

  1. **The doors.** Every Core path from a CLR `Type` (or its nullability
     metadata) to a `TypeSymbol` is one of: `TypeSymbol.FromClrType`, the
     `MemberLookup.MapOpenClrTypeToSymbolic` overloads,
     and `ClrNullability.ReadNullableFlags` / `ClassifyFlag` /
     `ClassifyPosition`. A call to any of them is reported unless one of the
     next two points applies. The wrapper factories `NullableTypeSymbol.Get` and
     `PlatformTypeSymbol.Get` are *not* doors in general, because the language
     legitimately wraps types it already has (the `?.` result, a nil arm, a
     lifted operator). But the round-1 walker clause stays: **inside** a
     `[NullabilityFunnel]` member other than `NullabilityImportRule`, a direct
     wrapper-factory call is reported, so the walkers resolve every classified
     position through the rule.
  2. **The funnel is declared per member, not per type.** An internal
     `[NullabilityFunnel]` attribute marks the members allowed to call the
     doors: `NullabilityImportRule`, the Layer 1 walkers, the `MemberLookup.GetClr*`
     family (with `ResolveInstanceReturnTypeFromReceiver` moved into it in
     Phase 2), and the symbolic projection itself. Exempting whole types would
     not work. `MemberLookup` is over 8,000 lines, and exempting it would also
     exempt `ResolveCallReturnTypeFromSymbolicTypeArgs`, the known gap. Adding
     the attribute to a member is the reviewed exception #4363 asks for: it
     shows up in the diff, and the analyzer's tests list every attributed
     member, so a new one fails a test until that list is updated.
  3. **A named door for audited nullability-free conversions.** Most of the
     337 `FromClrType` calls on `main` convert a type that has no declaration
     nullability to lose, such as a `typeof` target, a primitive, or a type
     compared only for identity in overload resolution or emit. They move to
     `TypeSymbol.FromClrTypeWithoutNullability(Type, NullabilityFreeReason)`.
     The reason is a required enum argument (e.g. `TypeLiteral`,
     `IdentityComparison`, `EmitLowering`, `KnownPrimitive`), so every such
     call states why nullability doesn't apply, in a form the analyzer can
     see. GSA0007 allows this door anywhere, with one exception. It still
     reports a call whose argument is, *within the same method*, a signature
     accessor (`ReturnType`, `ReturnParameter`, `ParameterType`,
     `PropertyType`, `FieldType`, `EventHandlerType`, or
     `GetGenericArguments()` of one of those).

  **What this leaves open, stated honestly.** Someone can still pass a
  signature `Type` through a helper into `FromClrTypeWithoutNullability` with
  a false reason. That can't be detected without interprocedural analysis. But
  the escape is now a call that says in its own name that it drops
  nullability, and it names a reason a reviewer can check. That is the
  explicit, reviewable exception #4363 asked for, instead of the silent
  bypass that exists today. Inside the funnel members, correctness rests on
  `NullabilityImportRule`, the walker clause above and the reader-agreement
  test (§4).

  **No type-level exemptions.** The doors' own implementations are exempt
  **member by member**. Each door's body (`TypeSymbol.FromClrType`, which
  recurses on its own element and underlying types; the
  `MapOpenClrTypeToSymbolic` overloads; `ReadNullableFlags`, `ClassifyFlag` and
  `ClassifyPosition`) carries `[NullabilityFunnel]` like any other funnel
  member. No declaring type is exempt as a whole. This matters because the
  doors live in large, general-purpose types. `TypeSymbol` itself calls
  `FromClrType` from members that have nothing to do with the funnel:
  `ConstructedTypeArguments` (`TypeSymbol.cs:163`), `ConstructedFrom` (177),
  `BaseType` (200) and the tuple element projection (~1790, ~1802).
  `ClrNullability` has eight `FromClrType` calls of its own. A type-level
  exemption would let a future call anywhere in `TypeSymbol` or
  `ClrNullability` skip GSA0007 without a reason or an attribute. These are
  the same types `ReflectionTypeComparisonAnalyzer` would handle with
  `IsInsideExemptType`. GSA0007 deliberately does not follow that part of its
  pattern.
- **GSA0008 — consumer query.** Any **operation** that tests for, converts
  to, or names `NullableTypeSymbol`, `PlatformTypeSymbol` or
  `NullabilityAnnotatedTypeSymbol` as a type is reported, with a message
  naming the query member to use, unless it sits in a member marked
  `[NullabilityRepresentation(reason)]`. The rule is written against Roslyn's
  `IOperation` tree, not against syntax, so every source form that reaches a
  wrapper type goes through the same few operation kinds and none needs its
  own clause:
  - `is` / `as`: `IIsTypeOperation`, and `IConversionOperation` with
    `IsTryCast`;
  - explicit casts such as `(PlatformTypeSymbol)from`:
    `IConversionOperation`, explicit, whose target is a wrapper type;
  - type, declaration and recursive patterns wherever they appear, including
    `case` labels, switch-expression arms, `or` / `and` / `not` combinators,
    and nested property, positional and list subpatterns. These are
    `ITypePatternOperation`, `IDeclarationPatternOperation` and
    `IRecursivePatternOperation`, checked by their matched type;
  - `typeof(...)`: `ITypeOfOperation`;
  - a wrapper type passed as a generic type argument, such as
    `OfType<NullableTypeSymbol>()` or `Cast<…>()`: `IInvocationOperation`
    whose method has a wrapper type argument;
  - a wrapper type used as a generic constraint (a declaration, not an
    operation), reported by a symbol action on type parameters.

  None of the last three occur in `src/Core` today, but covering them costs
  nothing and closes the obvious workarounds. The analyzer tests have one case
  per form. As with GSA0007,
  exemption is **per member, never per type**. The members that get the
  attribute are those whose job *is* the representation:
  - the query API's own implementation;
  - the two wrapper factories;
  - the Layer 1 walkers' structure reads;
  - `NullableLifting`'s value-nullable checks;
  - `SymbolDisplay`'s nullability rendering;
  - signature and metadata encoding in `NullableFlagsBuilder` and
    `ReflectionMetadataEmitter`.

  Each attribute carries a one-line reason. Other members of those same types
  are checked like any other code. `MethodBodyEmitter` and `SlotPlanner` are **not** exempt, although
  most of their wrapper tests are value-nullable questions: those migrate too,
  onto `NullableLifting.IsAnyValueTypeNullable` or a
  `TypeSymbol.TryGetValueNullableUnderlying(out TypeSymbol)` query. Exempting the
  emitter by type would exempt its ~80 sites wholesale, which is an allowlist by
  another name. There is **no** per-site allowlist file: Phase 3 migrates every
  site (owner decision 4), so the exempt set is a short list of attributed
  members that *are* the representation, not a ledger of debt. The analyzer's
  tests list every attributed member, for both GSA0007 and GSA0008, so a new
  exemption fails a test until it is added to that list, and so shows up in
  review.
- Both rules are added to `AnalyzerReleases.Unshipped.md` (next free IDs after
  GSA0006) at warning severity, as GSA0001–GSA0006 are. The repository builds
  with `TreatWarningsAsErrors` (`build/gsharp.build.props`, imported by the root
  `Directory.Build.props`), so a violation fails the build.
- Analyzer tests live beside the existing ones and include, for each rule, the
  historical instance it would have caught (`ResolveCallReturnTypeFromSymbolicTypeArgs`'s
  unmerged return for GSA0007; the lambda join's missing platform arm for
  GSA0008).

### 4. The reader-agreement test

A differential test asserts that the Layer 1 readers agree about every position
of every declaration: for each public member signature position, the direct
reader, the projection reader (at an erased closing *and* at a symbolic closing),
the merge, and the lazy accessor must produce the same
`ReferenceNullability` at every position `GetElementPositions()` enumerates. It is
the generalisation of ADR-0136's `Issue3705MemberKindNullabilityDifferentialTests`
from member kinds to readers.

- **Corpus:** full scope — every public member of every assembly in the
  reference set gsc itself resolves (the BCL targeting pack), plus the
  unannotated fixtures #4361 was reduced from (netstandard2.0 /
  `#nullable disable` metadata, emitted by `csc` so it survives
  self-migration, as `aac0c452b` did for the #4361 reader test). Not a smoke
  subset (owner decision 6).
- **CI:** its own dedicated shard in `.github/workflows/build.yml`, running in
  parallel with the existing `Core.Tests` shards — not inline in one of them, and
  not a nightly-only lane (owner decision 6). The `test-partition` job fails
  unless the shard filters partition every test exactly, so the new shard's
  filter must be registered there and excluded from the `Core.Tests` shards'
  filters in the same change.
- **Wall-clock time (measured on CI, Phase 1 PR #4406):**
  - The `tests (core-reader-agreement)` job took **3 m 18 s** end to end.
  - The **Test step took 10 s**: all four corpora, run in parallel.
  - Most of the job is the shard's fixed cost: checkout, restore, and a
    2 m 38 s solution build, the same as every other `tests` shard.
  - For comparison, `core-remainder` took 6 m 33 s and `core-binding` took
    13 m 37 s in the same run.
  - So full scope costs one extra runner, and about 10 s of it is the test
    itself.
- **As built (Phase 1).** The test is `test/Core.Tests/ReaderAgreement/`, with
  one test class per corpus so the four corpora run in parallel. It is
  registered as the `core-reader-agreement` band in
  `build/generate-ci-test-matrix.py`, and `core-remainder` excludes it.
  - **Corpora:**
    - the `Microsoft.NETCore.App.Ref` targeting pack;
    - `netstandard.dll` 2.0 (no nullable metadata at all);
    - FsCheck;
    - a C# fixture emitted by `csc` at test time.
  - **Walk:** every public method, constructor, property, field and event
    of every public generic type, and every public generic method.
  - **Closings:** each declaration is closed over `string`, `string?`,
    `int32`, `List[string]` and an in-scope unconstrained `T`. A closing
    that violates a constraint is skipped. The harness checks constraints
    itself, because a `MetadataLoadContext` does not.
  - **Readers:** direct, projection at the erased closing, merge at the
    symbolic closing, `MemberLookup.GetClr*TypeSymbol`, the lazy accessor
    over the symbolic projection (the projection at a symbolic closing), and
    `ResolveCallReturnTypeFromSymbolicTypeArgs`.
    - A CLR closing cannot express `string?` or a G# `T`. For those two
      arguments only the symbolic readers run.
  - **Lazy-accessor cross-check:** every `NullabilityAnnotatedTypeSymbol`
    any reader returns is also checked. Its two lazy accessors must agree.
  - **Scale:** about 87,000 position closings, compared through about
    265,000 reader calls, with zero reader exceptions (the test fails on any).
  - **Allowlist:** each entry names the readers it excuses, the position fact
    it is limited to, and an issue:
    - `ResolveCallReturnTypeFromSymbolicTypeArgs` (#4363, closed by
      Phase 4);
    - #4401;
    - #4402;
    - #4403.

    An entry excuses a disagreement only when the remaining readers still
    agree.
  - **Local cost:** the harness itself takes about 5 s over all four
    corpora on a developer machine. The CI figure above is the shard's full
    job time, including its build.

### 5. Owner decisions (settled)

These were decided by the repository owner before this ADR was written. They are
the Decision, not options.

1. **`[Nullable(2)]` on an open slot.** `[Nullable(2)]T` means `T?` — reference
   nullability — when the substituted type argument is a reference type. When the
   substituted argument is a value type, it is ordinary CLR value-type semantics,
   handled by G#'s existing, separate value-nullability mechanism (ADR-0001), and
   not part of this ADR's system: `NullabilityImportRule.ApplyOpenSlot` adds no
   reference `?` to a value-type argument. This resolves the regression PR #4362's
   round 1 hit — `Enumerable.Min<TSource>()` on an unconstrained `TSource` was
   wrapped in an extra `?` for value-type instantiations.

   *Clarification of what "value-type semantics" means in metadata.* C#'s
   unconstrained `TSource?` on `Min<TSource>` is encoded as the bare generic
   parameter plus a `[Nullable(2)]` byte; the CLR signature has no `Nullable<>`
   in it, so `Min<int>` returns `int`, not `int?`. A `Nullable<V>` exists at such
   a position only when the signature itself spells it (a `where T : struct`
   `T?`), and then it arrives through the value-nullability path, never through
   this rule. The ruling therefore reduces, in the rule function, to: *reference
   argument → `T?`; value-type argument → the argument unchanged.* That is also
   what `main` already pins for a value-type instantiation:
   `Issue2494EnumLinqExtremaTests` (`test/Core.Tests/CodeAnalysis/Binding/`)
   asserts that `values.Min()` over a source enum binds as the enum itself, not
   its nullable.
2. **`--nullability=enabled` (ADR-0136) is retired** entirely; `platform-types`
   (ADR-0186) is the sole supported mode. The retirement itself is #4372 and is
   **not** performed by any phase here — but no phase builds new code that
   supports the mode being deleted. `NullabilityImportRule`, the query API and
   both analyzers have no mode branch.
3. **Enforcement is a live Roslyn analyzer** in `src/Analyzers/InternalAnalyzers`,
   following `ReflectionTypeComparisonAnalyzer.cs`, for both the producer funnel
   (Phase 2) and the consumer query API (Phase 3) — not a source-scanning test.
4. **The full consumer burn-down is in scope.** Phase 3 migrates every Layer 4
   site onto the query API; it does not add the API plus an allowlist that
   shrinks "eventually".
5. **cs2gs consolidates onto `NullabilityImportRule` directly** (Phase 5, in
   scope). cs2gs already reaches `src/Core/Core.csproj` (through
   `Cs2Gs.CodeModel` and `Cs2Gs.Pipeline`); there is no separate cs2gs-side
   reimplementation of the rule afterwards.
6. **The reader-agreement test runs at full scope** (the real reference BCL
   corpus) as its own dedicated CI shard, in parallel with the `Core.Tests`
   shards. Its wall-clock time is measured and reported when it is built, not
   estimated here.
7. **This is a standalone ADR.** ADR-0186's text is not amended.

## Implementation plan

Five phases, **each one PR**, sequentially landable and green — the convention
ADR-0186 established with its seven single-PR steps. Each phase's PR updates this
ADR with an implementation note where reality differed from the plan, as
ADR-0186's steps did.

**Dependency check.** Each phase builds, and its tests pass, using only what
the phases before it have landed. What each phase needs, and where it comes
from:

| Phase | Needs | Introduced by |
|---|---|---|
| 1 | Answer to Open question 1; nothing else (**met** 2026-09-24: `Unchanged`) | The repository owner |
| 2 | `NullabilityImportRule` (walkers already routed through it) | Phase 1 |
| 2 | `[NullabilityFunnel]`, `FromClrTypeWithoutNullability`, `NullabilityFreeReason` | Phase 2 itself |
| 3 | `ReferenceNullability`, `GetElementPositions()` | Phase 1 |
| 3 | Rest of the query API, `[NullabilityRepresentation]` | Phase 3 itself |
| 4 | `ApplyOpenSlot` with decision 1 | Phase 1 |
| 4 | The funnel attribute and the suppression it removes | Phase 2 |
| 4 | Symbolic-projection consumers that read through a platform wrapper | Phase 3 |
| ADR-0186 step 6 | `NullabilityImportRule`, `TypeArgumentKind`, the `InternalsVisibleTo` grant | Phase 1 |
| 5 | The adapter and applier | ADR-0186 step 6 |
| 5 | GSA0009 | Phase 5 itself |

No phase uses anything a later phase introduces.

### Phase 1 — the rule function, the agreement test, and two Layer 0/6 fixes

- **Entry condition:** Open question 1 (the `Annotated` × `Unknown` cell) has
  been answered by the repository owner. **Met 2026-09-24:** the cell is
  `Unchanged`, as §1 proposes. Phase 1 is unblocked.
- Add `ImportedReferenceNullability`, `TypeArgumentKind` and
  `NullabilityImportRule`: the representation-neutral
  `DecideConcrete`/`DecideOpenSlot`, and gsc's `ApplyConcrete`/`ApplyOpenSlot`
  appliers, with decision 1's open-slot semantics.
- Add the **two read-only query members the agreement test needs**:
  `TypeSymbol.ReferenceNullability` and `TypeSymbol.GetElementPositions()`,
  with their full §2 semantics, over both Layer 3 representations. No consumer
  moves onto them in this phase. They exist so that §4's test compares the
  readers through the same accessors every consumer will use after Phase 3,
  rather than through a test-only reimplementation. The rest of the query API
  stays in Phase 3.
- Add `<InternalsVisibleTo Include="GSharp.Cs2Gs.Translator" />` to
  `src/Core/Core.csproj`. It is the assembly name, not the project name:
  `build/gsharp.build.props` sets
  `<AssemblyName>GSharp.$(MSBuildProjectName)</AssemblyName>`, which
  `tools/Directory.Build.props` inherits, and the translator project's own
  existing entry is likewise `GSharp.Cs2Gs.Tests`. The grant lands here rather
  than in Phase 5 because ADR-0186 step 6, which must call the rule, lands
  before Phase 5. Granting internals is preferred over widening the rule to
  `public`: the rule is compiler-internal policy, and gsc's public API surface
  should not grow for a sibling tool.
- Route the three walkers' per-position decisions through it:
  `ClrNullability.SymbolFromFlagsOffset`, `ClrNullability.ProjectNullableFlags`
  (its `layout.IsGenericParameter` arm, ~line 972, becomes a call to
  `ApplyOpenSlot`), `NullableFlagsBuilder.MergeDeclarationNullability` (its
  open-parameter arm), and `NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol`
  / `GetTypeArgumentSymbolForClrType`. Under platform types,
  `ClrNullability.SymbolForState` delegates to `ApplyConcrete`.
- Fix `ConversionClassifier.PreserveParameterTopLevelNullability`
  (`ConversionClassifier.cs:3176`) to classify through
  `ClrNullability.ClassifyPosition(flags, 0)` instead of comparing
  `flags[0] == NullableFlagsBuilder.Annotated`.
- Normalise `PlatformTypeSymbol.Get` (`PlatformTypeSymbol.cs:94`): `Nullable(U)`
  → `Nullable(U)`, value type → itself; widen its return type to `TypeSymbol`
  and fix the callers that relied on the narrower type (there are five non-test
  call sites at `7a44ca033`, so the widening is small and reviewable).
- Add the reader-agreement test and its dedicated CI shard, including the
  `test-partition` registration. Record the measured wall-clock time in §4.
- No analyzer yet: this phase makes the funnel exist and proves the readers
  agree through it.

#### Phase 1 implementation note

Where the implementation differed from the plan above, or had to decide
something the plan left open:

- **The rule and its appliers** are in
  `src/Core/CodeAnalysis/Symbols/NullabilityImportRule.cs`, as specified.
  - The argument classifier, `NullabilityImportRule.ClassifyArgument`, has
    overloads for both `TypeSymbol` and CLR `Type`. It is the one classifier
    shared by the appliers and by `PlatformTypeSymbol.Get`'s value-type
    normalisation.
  - A `TupleTypeSymbol` is `Value`. A `TypeParameterSymbol` is `Value` for
    `struct`/`unmanaged`, `Reference` for `class`, a class constraint, or a
    dependent bound that proves a reference type, and `Unknown` otherwise.
  - `DecideConcrete` reads an `Unknown` kind as `Reference`. A concrete
    position whose kind is unknown is a CLR generic parameter read directly
    off an open definition. It is read the way the declaration spells it, as
    the direct reader always has.
- **The projection reader is byte-valued**, so its open-slot arm cannot call
  the `TypeSymbol` applier.
  - Under platform types it calls `NullabilityImportRule.ApplyOpenSlotToFlags`.
    That is a third, byte-domain applier over the same `DecideOpenSlot`.
  - This fixed a drift from the merge. An explicit `2` used to be expanded
    over *every* position of the substituted argument, so
    `[Nullable(2)] TSource` at `TSource := List<string>` read
    `List<string?>?` here and `List<string>?` through the merge.
  - The slot's `?` now lands on the argument's root only, and a value-type
    argument takes none: `KeyValuePair<string, string>` no longer gets
    `string?` elements.
- **`Annotated` × `Unknown` is a behaviour change** (see §1's correction).
  The merge's open-slot arm now calls `ApplyOpenSlot`, so an unconstrained G#
  `T` at an explicit `[Nullable(2)]` slot stays `T`. It used to become `T?`,
  for example `List[T].Find` inside a generic function.
- **An unsubstituted slot is not an open slot.** Sometimes the projection
  leaves the declaration's *own* generic parameter at the slot. For example,
  a method-level `T` read with no method type arguments. The adapter contract
  check (`adapt[I](…)`) compares `T? Echo<T>` with `T Echo<T>` this way.
  - Nothing arrived to speak for such a slot, so it is not an `Unknown`
    argument. Classifying it as one erased the `?` and let
    `InterfaceAdaptationReviewTests` accept a nullability-mismatched adapter.
  - `NullabilityImportRule.IsUnsubstitutedSlot` identifies the case. The
    merge and the projection then read it as the declaration spells it, as
    the direct reader reads the open definition, and as both did before.
  - `DecideOpenSlot` is **not consulted** for such a position, so its table
    has no contradicted cell. The `Annotated` × `Unknown` → `Unchanged` cell
    applies only when a real argument, an in-scope G# type parameter, was
    substituted into the slot.
- **Legacy mode.** `--nullability=enabled` keeps its own arm in all three
  places that branch on the mode: `SymbolForState`, `ProjectNullableFlags`
  and the merge. The rule has no mode branch.
- **The query members.**
  - `ReferenceNullability` returns a new enum, `ReferenceNullabilityKind`
    (`NotApplicable`, `NotNull`, `Nullable`, `Platform`), not
    `ImportedReferenceNullability`. That enum is the rule's *decision*, and
    its fourth value means "leave the input alone", which is not a query
    answer.
  - `GetElementPositions()` treats a top-level `?`, `!`, `Nullable<V>` or
    by-ref as transparent, as metadata lays it out.
  - It splices a canonical eight-argument tuple's `TRest` into the element
    list, so every representation of a tuple lists its elements, as
    `TupleTypeSymbol` already does (issue #2750).
  - Both members are `internal`. No consumer uses them yet.
- **`PlatformTypeSymbol.Get`.** There were four non-test callers at this
  phase, not five. All four already stored the result as `TypeSymbol`, so the
  widening needed no caller changes.
  - Normalising value types also removes one representable-but-meaningless
    shape. `FromClrType` maps the *reference* type `System.Tuple<…>` onto a
    value `TupleTypeSymbol` (#1922), so an oblivious `System.Tuple` position
    used to read as `(T1, T2)!`. It now reads as `(T1, T2)`.
  - The #1922 split itself is #4401 (below).
- **`InternalsVisibleTo`** was added for `GSharp.Cs2Gs.Translator`, as
  planned.
- **What the reader-agreement test found (§4), and what was done:**
  - *Fixed here (small, clear bugs):*
    - `ClrNullability.GetFieldTypeSymbol`, `GetPropertyTypeSymbol` and
      `GetPropertyElementTypeSymbol` read an open declaration's bytes against
      the *closed* type. That misaligned them and stamped an oblivious open
      slot's byte onto the argument, the #4361 defect on the one path its fix
      did not reach. Like the method and parameter readers, they now project
      through the open declaration.
    - `NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType` never
      merged a symbolic base's argument, so it disagreed with
      `GetTypeArgumentSymbol`. It now delegates to it once it finds the
      argument.
    - `MemberLookup.FindOpenIndexerDefinition` searched instance properties
      only, so a static property of a generic type (`Comparer[string?].Default`)
      fell back to the erased read and lost the receiver's `?`.
    - `MemberLookup.GetClrMethodReturnTypeSymbol` merged a `ref T` return
      against the by-ref type itself and produced a platform-wrapped by-ref.
      It now peels and re-wraps the by-ref, as the parameter branch does.
    - `MemberLookup.GetClrEventHandlerTypeSymbol(EventInfo)` returned a
      constructed generic's handler with no declared nullability at all. It
      now projects through the open event.
    - A static event of a generic type was read without its symbolic
      container. `ClrNullability.GetParameterTypeSymbol` read an indexer's
      parameter against the closed type, with no open layout. Both now
      project like their method siblings.
  - *The CLR argument classifier* follows a dependent bound
    (`where U : class where T : U`) transitively, as the `TypeSymbol`
    overload does. Without that, the two overloads disagreed on the same
    chain.
  - *The harness's own guards.* Two conditions fail the test:
    - any corpus-enumeration error, such as an unreadable type, a missing
      closed counterpart, or an unresolvable signature;
    - an empty corpus.

    A structural allowlist tag applies only when *every* path at which the
    readers differ lies inside a node of that kind. A known cause in one
    subtree therefore cannot excuse a new drift in another. An excusal must
    leave at least one reader standing.
  - *Allowlisted, each against a newly filed issue:*
    - #4401: the `System.Tuple` representation split above.
    - #4402: the merge does not descend into a concrete (parameter-free)
      array or value tuple, so it drops that position's inner nullability
      through a symbolic receiver. Fixing it changes the bound type of every
      such position, which needs its own corpus run.
    - #4403: only `ClrNullability.GetParameterTypeSymbol` lifts a
      `null`-default reference parameter to `T?`.
- **One planned reader was dropped from the test: the merge over
  `FromClrType` of an *erased* closing.** gsc never calls the merge on that
  input at the top level; it merges symbolic projections. Its only
  disagreements were #4402's, reached through a representation no producer
  hands it.

### Phase 2 — producer triage and the funnel analyzer

- Triage **every** door call in `src/Core`, not only the signature-position
  ones: all 337 `FromClrType` calls at `7a44ca033` (43 of them on a signature
  accessor), all 63 `MapOpenClrTypeToSymbolic` calls, and the
  `ReadNullableFlags` / wrapper-factory calls. Each one either moves inside a
  `[NullabilityFunnel]` member, gets routed through one (adding a merge where
  it was missing), or moves to `FromClrTypeWithoutNullability` with its
  `NullabilityFreeReason`. Private forwarding wrappers such as
  `StatementBinder.Loops.cs:592`'s `MapOpenClrTypeToSymbolic` are removed, not
  attributed. The triage explicitly covers the calls **inside the door-defining
  types**, which a type-level exemption would have hidden:
  - `TypeSymbol.ConstructedTypeArguments` (`TypeSymbol.cs:163`);
  - `ConstructedFrom` (177);
  - `BaseType` (200);
  - the tuple element projection (~1790, ~1802);
  - `ClrNullability`'s eight `FromClrType` calls.

  Only the door bodies themselves get `[NullabilityFunnel]`. Record the final
  counts in this ADR.
- Move `ExpressionBinder.ResolveInstanceReturnTypeFromReceiver`
  (`ExpressionBinder.Calls.Invocation.cs:452`) into the `MemberLookup.GetClr*`
  family as a receiver-projected return accessor, so every signature-position
  producer lives in one family.
- Introduce the pieces GSA0007 relies on, in this same PR: the internal
  `[NullabilityFunnel]` attribute, `TypeSymbol.FromClrTypeWithoutNullability`,
  and the `NullabilityFreeReason` enum.
- Put `ConversionClassifier.PreserveParameterTopLevelNullability` inside the
  funnel. It is attributed, or routed through `GetClrMethodParameterTypeSymbol`.
  Phase 1 left it calling `ClassifyPosition`, a door, from a member that is not
  a funnel member.
- Add GSA0007 and its tests. `MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs`
  is the one known violation that cannot be fixed in this phase (see Phase 4); it
  carries a `#pragma warning disable GSA0007` with a comment pointing at Phase 4,
  the only suppression the phase may add.

### Phase 3 — the query API and the full consumer migration

- Add the rest of the query API to `TypeSymbol`, implemented on
  `NullableLifting.IsAnyValueTypeNullable`:
  - `AdmitsNil`;
  - `IsStatedNullable`;
  - `StripReferenceNullability(deep)`;
  - `TryGetValueNullableUnderlying`;
  - `JoinReferenceNullability`;
  - `CoalesceReferenceNullability`.

  `ReferenceNullability` and `GetElementPositions()` already exist from
  Phase 1. Also add the `[NullabilityRepresentation(reason)]` attribute, and
  apply it to the query API's own members, Phase 1's included.
- Collapse the ten strip helpers (table above) onto
  `StripReferenceNullability`. Where a caller genuinely needs to see through
  `Nullable<V>` too (the variance check, `UnwrapPlatformAndNullable`'s callers),
  that becomes an explicit, separately named operation, not a strip-helper
  variant.
- Collapse the conditional (`UnionArmNullability`), switch-expression
  (`ComputeBestCommonType`) and lambda (`ComputeLambdaCommonType`) joins onto
  `JoinReferenceNullability`, and move `??`'s result onto
  `CoalesceReferenceNullability` (§2) — **not** onto the join — preserving
  today's behaviour and leaving #4364 open.
  Before changing the lambda join, reduce its missing platform arm to a failing
  program and add it as a regression test.
- ~~Replace the Layer 5 node-kind predicates' nullability disjunct
  (`CanBindClrInstanceMember`, `TryGetUserInstanceMemberReceiverType`) with a
  type-level `IsStatedNullable` test.~~ *Done differently by #4356:* both
  disjuncts were deleted outright rather than replaced, so no `IsStatedNullable`
  call is needed there. What remains for this phase is only that their plain
  `is not NullableTypeSymbol` test reads through the query API like any other
  Layer 4 site.
- Migrate **every** Layer 4 site, the emitter's value-nullable tests included.
  That is about 586 lines in 88 files at `7a44ca033` by the broadened grep; the
  analyzer's own census is authoritative. Add GSA0008 with its per-member
  `[NullabilityRepresentation]` exemptions. The phase is done when GSA0008
  reports nothing and there is no per-site suppression.
- Make the symbolic-projection consumers named in `b0c76053d` — `TryProjectErasedClrType`,
  member lookup, method type inference, emit — read through a platform wrapper
  via the query API. This is what Phase 4 needs, and what #4385 needs.
- **Exit criterion: #4385 is picked up.** Phase 3 is not complete until the
  deferred revisit of the `Annotated` × `Unknown` cell (`Unchanged` → `Platform`,
  i.e. `T!`; see Open question 1) is unblocked and someone owns it. The cell
  change itself may be a follow-up PR (it also needs `T!` over a maybe-value
  type parameter specified; #4385 lists that work). Phase 3 is not called done
  until:
  - its PR has merged with #4385's prerequisite in place: the
    symbolic-projection consumers above peel `PlatformTypeSymbol` over symbolic
    generics, so a `T!` there no longer degrades the projection (the GS0159 /
    ILVerify `StackUnexpected` failures PR #4362 hit);
  - #4385 has then been updated to say it is unblocked, with a link to the
    merged Phase 3 PR.
- **This phase is one PR, and it is atomic.** Once Core references GSA0008 the
  rule analyzes the whole compilation, so landing it "for the files already
  migrated" would need a path filter, suppressions or an unfinished-file list —
  the allowlist mechanism owner decision 4 rules out. The migration and the
  analyzer therefore land together. It is the largest PR in the plan (about 80
  files); the review burden is budgeted rather than split away, and the PR's
  description groups the diff by file ownership (binding / emit /
  lowering+display) so it can be reviewed in those slices without being landed
  in them.

### Phase 4 — close the symbolic-return gap

- Make `MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs`
  (`MemberLookup.cs:1641`) merge the declaration's return nullability through the
  Phase 2 funnel, on **every** non-null return (including the
  `Task`/`ValueTask`/`IAsyncEnumerable` arm). The method becomes a
  `[NullabilityFunnel]` member, and the Phase 2 suppression is removed.
- It is gated on **both** earlier results, because `b0c76053d` failed for two
  independent reasons: decision 1's open-slot ruling (via Phase 1's
  `ApplyOpenSlot`) is what keeps `Min()`/`Max()` on an unconstrained `T` from
  becoming `T?`; Phase 3's peeling consumers are what keep a root-only `!` from
  degrading `List[Func[Src, int32]]!` to the erased CLR shape and from breaking
  `ConvertDelegate[T]!` inference. Round 3's witnesses (`FirstOrDefault` over a
  symbolic tuple, `Ob.EmptyArr[string?]()` → `[]!string?`, the GS0159 /
  ilverify reproductions) become this phase's regression tests.
- This implements, for this path, ADR-0186 §5b's requirement that unwrapping
  `T!` not degrade a symbolic projection.
- #4385 shares this phase's Phase 3 prerequisite (consumers that peel the
  platform wrapper over symbolic generics) but not its gate: it is unblocked by
  Phase 3, not by Phase 4, and neither waits for the other. Its exit criterion
  is in Phase 3.

### Phase 5 — consolidate cs2gs onto `NullabilityImportRule`

- Complete the `NullableAnnotation` → `ClrNullabilityState` adapter
  (`NullabilityImportAdapter`) and its `GTypeReference` applier in
  `Cs2Gs.Translator`. ADR-0186 step 6 creates both, because it lands first (see
  Sequencing). Phase 5 adds whatever members that step did not need, and
  replaces cs2gs's import-rule decisions (the ~100
  `NullableAnnotation` comparisons that decide a G# spelling, including
  `CSharpTypeMapper.cs:443/564/613` and
  `CSharpToGSharpTranslator.Nullability.cs`'s `IsImportedObliviousNullableTarget`)
  with calls to `NullabilityImportRule.DecideConcrete`/`DecideOpenSlot` through a
  cs2gs applier that maps the neutral result onto `GTypeReference` (§1). The
  usage-driven promotion logic in that file is not the import rule and keeps its
  behaviour, but it reads a position's declared state through the same adapter
  rather than through `NullableAnnotation` directly (see Enforcement).
- **Access.** `NullabilityImportRule`, `ClrNullabilityState` and
  `TypeArgumentKind` are `internal`. The `GSharp.Cs2Gs.Translator` grant was
  added in Phase 1, so neither ADR-0186 step 6 nor this phase changes
  `Core.csproj`.
- **Sequencing.** ADR-0186 step 6 (cs2gs: the per-position Roslyn read, and
  gutting the fixpoint in `ObliviousNullabilityAnalyzer.cs`) has not landed.
  The order is:
  1. Phase 1 of this ADR;
  2. ADR-0186 step 6, which may land before, between or after Phases 2–4,
     since it touches only cs2gs and they touch only Core;
  3. Phase 5.

  Step 6's PR writes its new per-position read against `NullabilityImportRule`,
  through the adapter and applier it creates, rather than against
  `NullableAnnotation` directly. It needs nothing from Phases 2–4. Phase 5
  then migrates whatever import-rule decisions remain outside step 6's scope,
  so no code is migrated onto the rule twice.
- **Enforcement.** GSA0007/GSA0008 police gsc's `TypeSymbol` wrappers and CLR
  signature positions; cs2gs works in Roslyn `ITypeSymbol` and they would fire
  on nothing there. This phase adds **GSA0009**: any read of Roslyn's
  `NullableAnnotation` (the `ITypeSymbol.NullableAnnotation`,
  `ElementNullableAnnotation` and `TypeInfo.Nullability.Annotation` accessors,
  and comparisons against the enum) in `Cs2Gs.Translator` outside the one
  adapter type is reported — **regardless of the enclosing member's return
  type**. A shape-based rule (e.g. "only in members that produce a
  `GTypeReference`") would miss `bool`-returning deciders such as
  `IsImportedObliviousNullableTarget` and could be evaded by extracting any
  comparison into a helper, so it is not used.

  The adapter therefore does **not** expose a raw `ClrNullabilityState`. If it
  did, usage inference could not do anything with the value: GSA0009 also
  reports a `ClrNullabilityState` comparison outside the adapter and the rule
  class, so that it cannot become a back door for hand-deciding a spelling.
  Instead the adapter (`Cs2Gs.Translator`'s `NullabilityImportAdapter`) exposes
  two kinds of member, and every one of the ~100 current reads migrates onto
  one of them:
  - **Spelling operations** that apply the shared decision and return a
    `GTypeReference`: `ApplyToDeclaration(GTypeReference, ITypeSymbol)`,
    `ApplyToOpenSlot(GTypeReference argument, ITypeParameterSymbol slot, ITypeSymbol declared)`.
  - **Semantic predicates** for usage inference and bridging, each answering
    one named question and none returning the state itself:
    `IsDeclaredOblivious(ITypeSymbol)`, `IsDeclaredNullable(ITypeSymbol)`,
    `IsDeclaredNonNull(ITypeSymbol)`, the element forms
    `IsElementDeclaredOblivious/Nullable/NonNull(IArrayTypeSymbol)`, and
    `IsFlowNullable(TypeInfo)` for the flow-state reads
    (`TypeInfo.Nullability.Annotation`) the translator makes today. Each
    predicate is written in terms of the same classification the rule uses,
    so a usage decision and a spelling decision cannot disagree about what a
    declaration says.

  Phase 5 inventories the ~100 reads, maps each onto one of these members (or
  a new, equally narrow predicate added to the adapter with its own test), and
  records the final list in this ADR. Because nothing outside the adapter can
  see a state value, GSA0009 needs no exemptions beyond the adapter's own
  members and the rule's members. Those are marked per member, like GSA0007 and
  GSA0008, and the analyzer's tests list them. The translator project gains an analyzer reference to
  `InternalAnalyzers` (today only `Cs2Gs.Tests` has one). Verify with the full
  self-migration gate.

## Consequences

### Positive

- A new reader, producer or consumer cannot compute nullability its own way
  without a build diagnostic naming the choke point it bypassed. The defect class
  in #4363 becomes a compile-time error in the compiler's own source rather than
  a review finding.
- The reader-agreement test catches Layer 1 drift across the whole BCL on every
  PR, which is where `c478e44ab`, `ea81a944f` and #4361 each came from.
- `T?!` becomes unconstructible, closing the mirror of the `T!?` bug by
  construction rather than by a fourth review finding.
- The #4361 symbolic-return gap closes, with its two blockers removed rather than
  worked around.
- cs2gs and gsc cannot disagree about the import rule, because there is one.
- Removing the dual-mode branches from new code makes #4372's retirement smaller.

### Negative

- Phase 3 touches about 80 files; it is the largest refactor since ADR-0186
  step 5 and will conflict with in-flight binder work. It should not run
  concurrently with another binder-wide change.
- `NullableTypeSymbol` still represents both reference and value optionality. The
  query API hides that from consumers but does not remove it; a future ADR may
  split the representation, and this one deliberately does not.
- The analyzers' exemptions are a judgement about which members *are* the
  funnel or the representation. A wrong exemption re-opens a hole. Every
  exemption is therefore a per-member attribute with a stated reason, pinned by
  the analyzer's tests, and reviewed like code. There are no type-level
  exemptions.
- The agreement test adds a CI shard and its runtime. The cost is recorded, not
  estimated.
- cs2gs gains an `InternalsVisibleTo` dependency on Core internals.

### Neutral

- No language or diagnostic behaviour changes, except where a phase fixes a
  defect (Phase 3's lambda join, Phase 4's symbolic return), each with a release
  note.

## Alternatives considered

- **One universal nullability function for every layer.** Rejected: the readers
  take physically different inputs — a CLR `Type` alone, a closed `Type` against
  its open layout, a symbol against a layout, a Roslyn `ITypeSymbol` — and forcing
  them through one signature would either reintroduce per-input branching inside
  it or discard information one of them needs. What they share is the *rule*
  for a classified position, which is exactly the part this ADR funnels. The
  structure walk stays per input, and the agreement test pins the walks together.
- **Represent `?`/`!` as flags on one wrapper instead of distinct symbols.**
  Already rejected by ADR-0186 §1 for its own reasons: a flag preserves exactly
  the defect that type identity eliminates, because consumers can (and did)
  forget to read it. The query API is the consumer-side counterpart of that
  decision, not a reversal of it.
- **Keep reviewing case by case.** Rejected: every instance in the Context
  section was found by review or a corpus run and fixed correctly, and the class
  kept recurring anyway. The recurrence rate is the reason for this ADR.
- **A source-scanning test instead of an analyzer.** Rejected by owner decision 3:
  a test runs after the fact and outside the IDE; an analyzer reports at the
  line, in the build, where the new path is written.
- **An allowlist for the consumer migration.** Rejected by owner decision 4: an
  allowlist that "shrinks eventually" is the state the codebase is already in,
  minus the list.

## Open questions for the implementer

1. **The `Annotated` × `Unknown` cell of `DecideOpenSlot` — resolved
   2026-09-24.** Decision 1 rules on reference and value-type arguments; an
   unconstrained G# type parameter is neither. The repository owner confirmed
   §1's `Unchanged` (today's behaviour on `main`, and the only value that does
   not reintroduce PR #4362 round 1's `Min()` regression), accepting the
   soundness cost §1 states. `Platform` (`T!`) is deferred, not rejected: it
   needs Phase 3's peeling consumers and a definition of `T!` over a type
   parameter that may be a value type. The revisit is tracked in #4385 and is a
   Phase 3 exit criterion. Phase 1 implements `Unchanged` in that one cell.
2. **The audit's third Layer 5 predicate** was not located. Phase 3 either finds
   it (GSA0008 will) or records that there were two.
