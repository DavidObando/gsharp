# ADR-0224: Source nullable type parameters require a proven representation kind

- **Status**: Accepted
- **Date**: 2026-11-17
- **Phase**: Language safety and CLR interop
- **Related**: [#6040](https://github.com/DavidObando/gsharp/issues/6040), [#6043](https://github.com/DavidObando/gsharp/issues/6043), [ADR-0001](0001-null-model.md), [ADR-0084](0084-gsharp-extensions-optional-sequences.md), [ADR-0087](0087-reified-generics-emit-audit.md), [ADR-0100](0100-default-expression.md), [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md), [ADR-0220](0220-type-level-nullability-metadata-and-constraints.md)

## Context

The CLR cannot represent structural nullability over an unrestricted generic parameter with its ordinary generic parameter signature.
G# used that signature for an unconstrained source `T?`, but substituted `Nullable<int32>` at a closed call.
The declaration and caller then disagreed about the stack type.

```gsharp
func Missing[T]() T? -> default(T)
```

Calling `Missing[int32]()` could compile without diagnostics and emit invalid IL (#6040).
The same mismatch affected generic field storage (#6043).
A caller adapter cannot recover presence after the declaration erases it.
For example, `nil` and `default(T)` both become a raw zero when `T` is `int32`.
Wrapping that zero incorrectly makes `nil` present.

The maintainer chose a source constraint restriction instead of a new generic ABI.
This intentionally rejects some previously accepted programs, including the example above.
The earlier proposed companion design in draft PR #6044 was not accepted or released.
This decision replaces that proposal, not the separate compiler-as-library ADR-0223.

## Decision

### Source eligibility

A source nullable annotation or nullable-producing operator over an open type parameter requires proof of one representation kind.
The binder uses the canonical type-parameter constraint proof, not a closed caller's current type argument.

| Constraint proof | Source `T?` |
| --- | --- |
| `T class` or `T class?` | Allowed: nullable reference representation |
| A concrete, non-universal reference-class bound | Allowed: nullable reference representation |
| A dependent bound leading to such a reference-class bound | Allowed: nullable reference representation |
| `T struct` or `T unmanaged` | Allowed: `System.Nullable<T>` |
| No bound, `any`, `comparable`, `init()`, `notnull`, or interface-only bounds | Rejected: kind remains unknown |
| Only universal `object`, `System.ValueType`, or `System.Enum` bounds | Rejected: these do not prove reference kind |

`notnull` admits both nonnullable reference and value types.
An interface can have both class and struct implementations.
Neither establishes a nullable representation.

A dependent parameter does not inherit a bounding parameter's bare `class` flag.
For `[B class, T B]`, `B = object` and `T = int32` remain possible.
Thus `T?` is rejected unless `T` has another sufficient proof.
In contrast, `[B Animal, T B]` proves reference kind when `Animal` is a non-universal reference class.
Constraint cycles remain errors under the existing rules.
The compiler does not invent or propagate new CLR value-kind flags.

The rule applies to every source annotation: parameters, returns, fields, properties, locals, arrays, nested generic arguments, tuples, function types, delegates, interfaces, constraints, and type expressions.
An unknown-kind annotation reports **GS0641** at its `?` token.
An operator that creates such a result reports the same diagnostic at its source operator token.
This includes conditional access, delegate invocation, nil joins, and inferred lambda returns that introduce absence.
Nested tuple joins apply the same proof at the affected element.
Existing nullable arguments and imported annotation propagation do not independently construct a new missing-value representation.
Declaration annotations are checked after source headers and their complete constraint lists resolve.
This permits forward references and annotations inside a self-referential, reference-constrained bound.
Binding can retain an error's type for further analysis, but compilation must not emit an image.
Diagnostic suppression belongs to the current bind, not reusable type-parameter symbols.
Declaration failures are snapshotted with the global scope and shared read-only with body binders, including independent workers.
Body-local failures remain local to the current body bind, so incremental body edits cannot retain stale suppression.
Speculative partial-header checks roll back with ordinary diagnostics.
Each retained partial declaration reports its annotation once.

All source paths use one source-binding funnel.
The general nullable-symbol factory and imported signature readers do not perform this source eligibility check.
There is no compatibility mode for unrestricted source `T?`.
The same requirement applies when source operators synthesize `T?` without an explicit annotation.
Otherwise conditional access could bypass the rule and lose absence ([#6060](https://github.com/DavidObando/gsharp/issues/6060)).
The canonical kind classifier also rejects unsafe dependent class-flag propagation ([#6057](https://github.com/DavidObando/gsharp/issues/6057)).
The source rule does not validate every internal nullable-symbol construction or reinterpret foreign metadata as source annotations.

### Ordinary generics and nullable values

Ordinary unconstrained `T` keeps its existing CLR reification and accepts complete nullable arguments.

```gsharp
func Id[T](value T) T -> value
let absent = Id[int32?](nil)
let reference = Id[string?](nil)

func EmptyValue[T struct]() T? -> nil
func ZeroValue[T struct]() T? -> default(T)
func EmptyReference[T class?]() T? -> nil
```

`EmptyValue[int32]()` is absent.
`ZeroValue[int32]()` is present zero.
`default(T?)` is absent for an eligible parameter.
`default(T)` retains ADR-0100's ordinary reified default behavior.

A `struct` parameter cannot take `int32?`, because its constraint requires a nonnullable value type.
Use bare `T` when the entire argument may already be nullable.
Reference `class?` permits both `string` and `string?`.
Applying nullable reference syntax to an already nullable reference remains idempotent.
Existing concrete nullable normalization does not change.

### CLR boundary and storage

Accepted programs retain the existing ABI.
Reference annotations use ordinary CLR references and nullable metadata.
Value annotations use the actual `System.Nullable<T>` signature and layout.
Ordinary `T`, `typeof(T)`, reflection, dynamic calls, arrays, nested generics, delegates, and interface slots retain ordinary CLR identities.
Reference nullable annotations do not create a distinct reflection `Type`.
Struct nullable annotations do.

By-reference arguments and returns identify the complete declared storage slot.
Readonly aliases observe that same slot.
Nullable field writes preserve absence and present defaults.
This decision adds no copy/write-back bridge, boxing adapter, variance relaxation, runtime nil assertion, or evaluation-order change.
Interface implementations and overrides must preserve their declared slot's constraints and contracts.
Adding a constraint only to an implementation cannot repair an unrestricted interface declaration.

ADR-0193's imported `[Nullable(2)]T` policy is unchanged:

- A reference argument receives nullable reference semantics.
- A value argument remains unchanged.
- An unknown in-scope parameter remains unchanged.

An imported annotation is not an explicit structural G# source annotation.
`PlatformTypeSymbol` (`T!`) remains different from `NullableTypeSymbol` (`T?`).
The default remains `--nullability=platform-types`.
Source-owned assemblies still emit ordinary CLR signatures and Roslyn-compatible metadata.
G# reimport and C# consumption require no companion metadata or runtime carrier.
The #6039 source tuple-identity correction is independent and remains intact.

### Compatibility and migration

This is a source-breaking language change.
An API author must choose its actual domain, not add `class` merely to make a build succeed:

1. Use a reference constraint for reference-only APIs; choose `class?` when nullable reference arguments are valid.
2. Use `struct` or `unmanaged` for nonnullable value arguments whose nullable form the API constructs.
3. Use bare `T` when callers supply the complete type, including an already nullable type.
4. Split a genuinely mixed API when its contract requires separately constructing nullable reference and value results.

This also applies to nullable iterator elements.
The compiler no longer expands an unrestricted `sequence[T?]` iterator into implicit reference/value overloads.
Declare the constrained families explicitly, with distinct names when their CLR signatures would otherwise collide.
The canonical source diagnostic replaces the iterator-only GS0508 check.
Independent body errors, such as an unknown identifier, remain diagnostics.

Preserve nil behavior, defaults, alias identity, and non-null return guarantees during migration.
Do not replace a nullable contract with throwing assertions or casts.
Caller constraints may need to propagate the chosen domain.
A dependent class flag alone is insufficient; use the proof rules above.

Regression fixture migrations retain their original rejected inputs.
Reference-only `as T`/coalesce calls (#2333), nested-enum interface contracts (#2898), and forwarded nullable interface bounds (#4988) use explicit reference constraints in their accepted controls.
The nullable iterator families (#2927) split reference and value domains, and dependent-bound controls (#4062) use concrete reference-class roots instead of inherited bare `class` flags.

Additional compatibility corrections preserve the original source as rejection witnesses:

| Fixture | Accepted control and reason |
| --- | --- |
| #1431 | `TResult struct`: the native-function inference call returns `int32`. The empty-result nullable assertion keeps its throwing contract. |
| #1516, #3409 | Reference constraints apply only to string-only `as T` and nullable `Describe` controls. Other bare generic methods retain value and nullable actual arguments. |
| #2725 | Add reference proof alongside the existing collection interface constraints; both actual receivers are `List[object]`. |
| #2962, #3595 | Nullable static-property and cross-assembly property contracts use reference constraints; their actual arguments are `string`. |
| #4010, #4993 | Value constraints apply to nullable forwarding and `Config` storage instantiated with `int32`. Other open container arguments remain unrestricted. |
| #773 | Separate reference and value receiver controls retain both nil fallback results. |
| #3058, #3099 | Out-assignment analysis covers both known kinds. Reflected nullable field storage uses the existing `int32` instantiation with a value constraint. |
| ADR-0186, ADR-0213 | The nullable container probe uses a reference constraint. The loop probes constrain `Box` to their actual `DateTimeOffset` value argument and retain GS0158 independently. |
| Generator copy-constructor projection | The nullable open-argument control requires reference kind. Concrete nullable-value arguments to ordinary unrestricted `Target[T]` remain covered separately. |
| cs2gs #1072, #3676, #3770, ADR-0161 | Original interface-only or unrestricted annotations are rejection witnesses. Explicit reference-constrained neighbors retain nullable returns, fields, assertions, and coalesce lowering. These examples do not establish reference-only production APIs. |
| cs2gs #4445 | The runtime fixture instantiates its affected helpers only with `string`. Reference constraints propagate through those fixture helpers; ordinary `Keep`, `Next`, and await contracts remain unrestricted. The concrete value control remains unchanged. |
| cs2gs managed-reference records, #5574, #5684 | Actual nullable arguments are reference-class managed handles, `Node`, and `List[int32]`. Reference-constrained controls retain the original alias, null-flow, and runtime assertions. |
| cs2gs #5633 | Original unrestricted inputs retain translation-shape and work/allocation checks, plus exact source-annotation rejections. Reference-constrained neighbors retain the string runtime oracles or valid binding controls. The captured-default runtime neighbor remains blocked as described below. The measured inputs remain unchanged. |

These are test-program migrations, not additional compiler-host API changes.
No production translator declarations gain constraints.
Some valid unrestricted C# nullable contracts therefore remain translation coverage gaps: their emitted source intentionally receives GS0641.
The translator must not erase those contracts or silently add production constraints.
Imported CLR signatures still follow ADR-0193.

Adding constraints can reject existing callers.
Changing an erased value slot to `Nullable<T>` can change method signatures and field layouts.
Rebuild affected producers and consumers together after an approved compiler release.
No automatic binary compatibility is promised for such API migrations.
Previously compiled unrestricted G# declarations remain ordinary imported CLR metadata.
The new source check cannot distinguish or repair their erased presence semantics.
Rebuilding their source is necessary.

This decision does not authorize a release or repository SDK adoption.
The implementation must build with the published compiler specified in `global.json`.
No new syntax, source-set exclusion, unpublished host compiler, or runtime dependency is needed.
Compiler publication and later SDK adoption require separate approval.

### Measured compiler migration

The semantic inventory used immutable tracked source from main commit `2553e11bef0491c85103f3fea2c6ece0a05c22dc`.
It bound the complete normal Core and CLI compile inputs and observed source nullable annotations.
It excluded C# inputs and source-program strings.

| Scope | Tracked compiled G# files | Affected files | Rejected annotations | Declarations |
| --- | ---: | ---: | ---: | ---: |
| Core and CLI | 783 | 1 | 3 | 1 private method |
| Direct shared dependencies | 60 | 0 | 0 | 0 |

The affected declaration was `GSharpAnalyzerDriver.Guarded[T]`.
Its return and two `default(T?)` expressions needed a known reference kind.
Its two semantically resolved callers supplied `ImmutableHashSet[string]` and `object?`.
Those observed callers justify `class?`, not `class`, without changing their behavior.
Twenty-three other open-parameter annotations already had reference proofs.

The first inventory predicted annotation eligibility with semantic symbols.
An expanded measurement applied the new public driver to the same complete, unchanged Core and CLI source sets.
It reported exactly three GS0641 diagnostics at `Guarded`'s annotations; CLI compilation succeeded.
After integrating main `a2a005ba56e170346361ce1ecd65e810fad16585`, the public driver repeated this result against a separate read-only archive of that exact main commit: all 783 normal tracked compiler inputs, the same three locations, and no CLI diagnostic.
The same measurement was repeated against exact main `96d51f80dd40ebc29193ca9d252baa2b360bd38a`, using fresh normal MSBuild response files and unchanged read-only source bytes: 780 Core inputs produced the same three GS0641 diagnostics; the three CLI inputs compiled without diagnostics.
As before, Core declaration errors prevent this untouched-source driver run from proving that all Core bodies are clean; the independent body observer remains a prediction, not a successful untouched-baseline full build.

### Remaining compatibility validation blockers

The reference-constrained runtime neighbors for cs2gs #4445 and the captured-default case in #5633 are not green.
Explicit Roslyn compilation of both the original and constrained C# prints `20` and `True`, respectively.
The translated constrained programs instead throw on both the published 0.5.698 public driver and this compiler.
Changing `class` to `class?` does not correct this result.
The translated tuple/default stores introduce runtime `!!` checks; these controls must not be made green by deleting the checks or weakening their runtime oracles.
The original unrestricted sources remain exact GS0641 rejection witnesses.
Resolving this pre-existing translation boundary requires a separate scope decision before this PR can be mergeable.
Core declaration errors prevented complete body validation by that driver.
An independent baseline semantic observer completed all bodies with no errors and inspected recursively wrapped expression types.
It reused the existing sound reference-kind proof rather than propagating bare class flags.
Six unknown-nullable expression nodes all belonged to `Guarded`'s three annotations and their derived uses.
It observed no additional source-operator site or caller propagation requirement.
The zero-additional-operator result is a semantic prediction, not a fully green new-policy baseline build.
The first shared-dependency appendix covered annotations only.
An expanded semantic pass also bound all 60 dependency files and found no unknown-nullable expression node.
Neither inventory certifies the full graph or downstream consumers.
It did not inventory tools, test projects, or test-program strings.
Subsequent implementation validation must establish those results separately.

## Consequences

- Unsupported source fails before invalid IL or presence-corrupting storage is emitted.
- Nil and present-zero remain distinct without a new runtime or ABI.
- Mixed nullable APIs require an explicit source migration.
- Published CLR annotation behavior remains unchanged; source and imported annotations have deliberately different eligibility boundaries.
- Public `Option` types remain outside this decision, as in ADR-0084.

Validation uses the public driver with the old accepted inputs retained as exact-location rejection witnesses.
Accepted constrained controls must pass unsuppressed ILVerify and exact-byte runtime checks.
They cover absence versus zero, direct and forwarded results, nullable actual arguments, field storage, aliases, evaluation counts, and value copies.
Constraint tests distinguish concrete-class dependent proofs from unsafe class-flag propagation.
Native C# fixtures use explicit Roslyn.
Metadata round trips, imported annotation controls, #6039, and affected existing regressions must remain correct.
The unchanged published-pin Release graph and standard deterministic self-host fixpoint remain requirements.

## Alternatives considered

- **Caller wrapping after raw-`T` erasure:** rejected; it manufactures presence for nil value instantiations.
- **Hidden nullable companions or a tagged carrier:** rejected in favor of a smaller language rule without a new ABI.
- **Object boxing:** rejected; it changes type identity, storage, and alias semantics.
- **Treat unrestricted source `T?` as bare `T`:** rejected; it silently drops the structural nullable contract.
- **Treat `notnull`, an interface, or a dependent `class` flag as reference proof:** rejected; value arguments remain possible.
- **Reject only observed value calls:** rejected; separate compilation and generic storage require a sound declaration.
