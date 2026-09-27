# ADR-0194: `[]T` native-slice source epoch

- **Status**: Proposed
- **Date**: 2026-09-27
- **Phase**: Pre-go2gs language and migration preparation
- **Related**: [ADR-0016](0016-slice-storage.md),
  [ADR-0132](0132-nullable-array-element-spelling.md),
  [ADR-0164](0164-native-rectangular-arrays.md),
  [ADR-0170](0170-escaped-identifiers.md),
  [ADR-0179](0179-gsfmt-canonical-formatter.md),
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md),
  [ADR-0191](0191-go-to-gsharp-migration-tool.md),
  [compatibility policy](../compatibility-and-stability.md),
  [preimplementation analysis](../go2gs-preimplementation-performance-and-slice-design.md)
- **Effect if accepted**: Supersede ADR-0016 and ADR-0190 only for the
  meanings of unsized `[]T` syntax and the name precedence of unescaped
  `array[...]`. Preserve ADR-0190's runtime representation and semantics,
  ADR-0132's element/container nullability distinction, and ADR-0164's
  rectangular-array syntax.

## Context

G# currently has two sequence categories:

- `[]T` and unshadowed `array[T]` are exact CLR `T[]` arrays. Array ranges copy.
- `slice[T]` and `readonly slice[T]` are the heap-storable shared descriptors
  implemented by ADR-0190. They carry length and capacity, share subranges,
  and have explicit array conversion.

That distinction is complete enough for Go translation, but the short spelling
is backwards: Go source `[]T` must be rendered as the longer `slice[T]`, while
CLR arrays retain the Go-shaped spelling. This is especially visible in
translated APIs and nested sequence types.

Changing the spelling is not merely cosmetic. Existing `[]T` source denotes
`T[]` metadata, reference identity and covariance, copying ranges, nullable
references, and CLR API compatibility. Reinterpreting it as `Slice<T>` changes
storage sharing, equality, default values, overload selection, reflection,
serialization, and public ABI even when the source still compiles.

The transition therefore needs:

1. one context-independent meaning for each spelling;
2. an exact CLR-array spelling that user declarations cannot shadow;
3. rank and nullability rules with no inferred reinterpretation;
4. semantic migration for G# and array-preserving output from cs2gs;
5. an explicit source epoch so a newer compiler never silently changes old
   source.

This change is an ergonomics and translation-fidelity decision. It is not a
performance optimization and does not alter ADR-0190's runtime types.

## Decision

Adopt a separately versioned source epoch in which **`[]T` means the existing
native `slice[T]` type**. Retain `slice[T]` as an equivalent long spelling.
Make unescaped `array[T]` an intrinsic exact-CLR-array spelling. Preserve the
existing rectangular forms `[,]T`, `[,,]T`, and so on.

The new meaning does not become active merely because a newer compiler is
installed. Projects and direct compiler/REPL invocations must select the source
epoch during the transition described below.

### 1. Type and literal spellings

| Spelling in the new epoch | Meaning |
| --- | --- |
| `[]T` | `Gsharp.Values.Slice<T>`; exactly equivalent to `slice[T]` |
| `readonly []T` | `Gsharp.Values.ReadOnlySlice<T>`; exactly equivalent to `readonly slice[T]` |
| `[]T{...}` | Native mutable slice literal backed by a fresh exact-element-type array |
| `readonly []T{...}` | Native read-only slice literal backed by a fresh exact-element-type array |
| `array[T]` | Exact CLR SZARRAY `T[]` |
| `array[T]{...}` | Exact CLR SZARRAY literal |
| `[n]T` | Existing zero-initialized CLR SZARRAY allocation expression |
| `[,]T`, `[,,]T`, ... | Existing CLR rectangular array types |
| `[d0, d1]T`, ... | Existing CLR rectangular array allocation expressions |

`[]T` and `slice[T]` are two source spellings for one nominal native type.
There is no implicit array-to-slice or slice-to-array conversion. Existing
ADR-0190 operations such as `FromArray`, `ToArray`, and `TryGetArray` remain
the explicit boundary.

Fixed-length `[N]T` source types retain their current representation in this
change. Go value-array semantics remain an ADR-0191 translator/runtime gate.

### 2. Nesting, readonly, and nullability

The syntax has one storage meaning at every nesting level:

| Spelling | Meaning |
| --- | --- |
| `[][]T` | `slice[slice[T]]` |
| `array[array[T]]` | jagged CLR array |
| `array[[]T]` | CLR array whose elements are native slices |
| `[]array[T]` | native slice whose elements are CLR arrays |
| `[]T?` | non-null native slice of nullable elements |
| `[]?T` | nullable native mutable-slice descriptor |
| `[]?T?` | nullable native mutable-slice descriptor of nullable elements |
| `readonly []T?` | non-null read-only slice of nullable elements |
| `readonly []?T` | nullable read-only-slice descriptor |
| `array[T?]` | CLR array of nullable elements |
| `array[T]?` | nullable CLR array reference |
| `array[T?]?` | nullable CLR array reference of nullable elements |

This preserves ADR-0132's rule that the marker adjacent to the element marks
the element and the marker adjacent to the container marks the container.
Parentheses remain valid for clarity. Existing `ref readonly` precedence is
unchanged: `ref readonly []T` is a readonly borrow of a mutable-slice
descriptor, while `ref (readonly []T)` is a writable borrow of a
read-only-element descriptor slot.

Readonly limits access through the descriptor; it does not make shared backing
storage immutable. Native slice equality remains descriptor equality and does
not become Go slice equality.

### 3. Exact-array name precedence and rank

Unescaped `array[...]` becomes compiler-reserved intrinsic syntax in the new
epoch. It cannot bind to a source or imported generic type named `array`.
ADR-0170's escape remains the opt-out:

```gs
let clrValues array[int32] = array[int32]{1, 2}
let domainValue $array[int32] = $array[int32]{}
let qualifiedValue models.array[int32] = models.array[int32]{}
```

`$array[...]` and qualified ordinary names always use normal name lookup.
Migration must add the escape or qualification when old source intended an
ordinary type named `array`; it must not silently redirect that source to the
intrinsic.

`array[T]` denotes rank-one SZARRAY only. This ADR adds no rank argument or new
array representation. ADR-0164's already-implemented `[,]T`, `[,,]T`, and
higher-rank forms remain canonical, so cs2gs renders:

```text
C# int[]    -> array[int32]
C# int[][]  -> array[array[int32]]
C# int[,]   -> [,]int32
C# int[,,]? -> [,,]?int32
```

Rank is never flattened or represented by nested arrays.

### 4. Source epoch contract

The implementation introduces two named epochs:

- `legacy-array-syntax`: `[]T` retains the current CLR-array meaning.
- `native-slice-syntax`: this ADR's meanings apply.

The compiler accepts a `--source-epoch` option. MSBuild exposes the same value
as `GsharpSourceEpoch`; the SDK passes it to every compiler invocation. `gsi`
and other direct hosts expose the same option. The selected epoch participates
in incremental-compilation, generated-source, and migration cache keys.

Rollout is staged:

1. **Preparation release.** The default remains `legacy-array-syntax`.
   cs2gs and repository-owned generators begin emitting explicit `array[T]`.
   Ambiguous legacy `[]T` uses receive a deprecation diagnostic with a
   binding-aware fix to `array[T]`. Explicit `slice[T]` remains available.
2. **Transition release.** New SDK templates select
   `native-slice-syntax`. A compilation containing unsized `[]T` syntax with no
   selected epoch fails with an actionable diagnostic; it is never guessed
   from compiler version, imports, expected types, or surrounding operations.
   `legacy-array-syntax` remains accepted for one release and warns.
3. **Completed transition.** `legacy-array-syntax` is rejected. Missing epoch
   remains an error for source containing unsized `[]T`; source without that
   syntax remains unaffected. `native-slice-syntax` may become the generated
   project default, but an old ambiguous file is never silently reinterpreted.

The exact release numbers and diagnostic IDs are assigned by the implementation
plan. The semantic staging above is required. Published packages, source
generators, editor services, scripts, and REPL entry points transition
together.

`gsfmt` is not a migrator. It formats according to the selected epoch and never
changes a type's storage category.

### 5. Binding-aware migration

Provide a migration command that binds source using
`legacy-array-syntax`, then rewrites semantic array nodes:

- `[]T` type clauses to `array[T]`;
- `[]T{...}` array literals to `array[T]{...}`;
- nullable container/element combinations without changing their meaning;
- nested and generic array positions recursively;
- ordinary unqualified `array[...]` references to `$array[...]` or a stable
  qualification when they refer to user types.

The migration preserves comments and source maps and does not rewrite indexing,
comments, strings, or unrelated bracket syntax. A lexical search-and-replace is
not an accepted implementation.

Before and after migration, tests compare bound type categories and public CLR
metadata, not only reparsed text. Array range copies, covariance, `params`,
`ref`/`out`, overload selection, reflection-visible signatures, nullable
containers/elements, and rectangular rank must remain unchanged.

### 6. Translator policy

cs2gs preserves C# storage semantics:

- every C# SZARRAY type becomes `array[T]`;
- every C# array literal becomes `array[T]{...}`;
- rectangular arrays retain ADR-0164 syntax;
- C# `Gsharp.Values.Slice<T>` and `ReadOnlySlice<T>` remain native slice
  categories and may print as `slice[T]` / `readonly slice[T]`;
- the printer never chooses a category from spelling context or an expected
  target type.

`ArrayTypeReference` and `NativeSliceTypeReference` remain distinct code-model
nodes. The source epoch changes printer policy, not semantic ownership.

go2gs may continue emitting `slice[T]` before the epoch switch. Once its output
profile selects `native-slice-syntax`, ordinary Go slices may print as `[]T`.
Go nil, comparison legality, byte-string behavior, and fixed value arrays
remain translator concerns; this spelling does not claim full Go semantics.

## Acceptance gates

The syntax switch cannot ship until all of the following pass:

1. cs2gs emits explicit arrays for rank-one types/literals, nested and nullable
   forms, generated source, `params`, and interop signatures.
2. A binding-aware migration preserves CLR metadata and behavior for old G#
   array source, including ordinary `array` name collisions.
3. Parser, formatter, completion, diagnostics, symbol display, REPL, direct
   compiler, SDK, and generated-source paths all honor the same epoch.
4. Conformance tests distinguish array copies from shared slice views,
   nullable containers from nullable elements, mutable from readonly access,
   and rank-one from rectangular arrays.
5. Implementation and reference assemblies agree; ILVerify and C# round trips
   preserve exact array versus native-slice signatures.
6. A mutant that binds an array node as a native slice, or a slice node as an
   array, fails semantic or metadata tests. Text snapshots alone are
   insufficient.
7. Old source with ambiguous `[]T` and no epoch fails rather than silently
   changing meaning.

The transition is no-go if exact CLR-array spelling, ordinary-name migration,
or old-source detection cannot be guaranteed. That does not block ADR-0191 M0;
go2gs can emit the stable `slice[T]` spelling until these gates pass.

## Consequences

Positive:

- Go slice types receive their conventional compact spelling without adding a
  new runtime representation.
- CLR arrays become explicit in G# and in cs2gs output.
- Nested types communicate storage and sharing directly.
- The epoch contract prevents a compiler upgrade from silently changing valid
  old source or public ABI.
- Existing rectangular-array syntax avoids a new rank grammar.

Negative:

- This is a breaking source transition with coordinated compiler, SDK, editor,
  formatter, cs2gs, generator, documentation, and migration work.
- Projects using unsized `[]T` must migrate or temporarily select the legacy
  epoch.
- Unescaped generic types named `array` require escaping or qualification.
- Supporting the temporary legacy epoch adds bounded compiler and tooling
  complexity for one release.

Neutral:

- `slice[T]` remains supported indefinitely as the explicit long spelling.
- Native runtime layout, ownership, append, range, equality, and interop
  semantics remain those accepted in ADR-0190.
- Performance work remains independent and evidence-driven.

## Alternatives considered

1. **Keep ADR-0190 indefinitely.** Fully capable and lowest cost, but preserves
   the least intuitive spelling for Go-shaped code and generated APIs.
2. **Change `[]T` immediately.** Rejected because valid old source can compile
   with different sharing and ABI.
3. **Infer array versus slice from context.** Rejected because type meaning
   would depend on overloads/imports and make generated code unstable.
4. **Deprecate `[]T` without reusing it.** Safer but forfeits the most useful
   compact slice spelling.
5. **Add `array[T, rank]`.** Rejected for this transition because ADR-0164
   already has complete rank-preserving syntax.
6. **Let ordinary `array` names shadow the intrinsic.** Rejected because
   cs2gs would lose a context-independent spelling for exact `T[]`.
7. **Use formatting or textual replacement as migration.** Rejected because it
   cannot distinguish type/literal nodes from indexing, comments, strings, or
   user-defined `array` types.
