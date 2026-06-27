# ADR-0132: `[]T?` array of nullable elements vs `[]?T` nullable array

- **Status**: Accepted
- **Date**: 2026-06-27
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0001 (nullable types `T?`), ADR-0016 (slice `[]T`), ADR-0073 (`a?[i]` null-conditional indexing), issues [#710](https://github.com/DavidObando/gsharp/issues/710), [#1046](https://github.com/DavidObando/gsharp/issues/1046) (nested element type clauses), [#1212](https://github.com/DavidObando/gsharp/issues/1212)

## Context

G# had **no** syntax for an "array of nullable elements" (the C# `T?[]`). A
trailing `?` on an array/slice type clause was parsed and bound as a **nullable
array** — the whole array reference possibly nil — i.e. `[]T?` meant `([]T)?`.

That single spelling created two problems:

1. There was no way to express a *non-nil* array whose **elements** are nullable
   (`Nullable<int32>[]`, or an `object[]` that legitimately stores nils). The
   `cs2gs` translator could not faithfully render C# `T?[]`.
2. Indexing a `[]T?` value was rejected with **GS0116 "Type '[]T?' is not
   indexable"** because the bound type was a `NullableTypeSymbol` wrapping a
   slice; the array had to be null-forgiven (`!!`) or accessed through the
   null-conditional `?[` before an element could be read.

Both the array-level and the element-level nullability are useful, and a single
trailing `?` cannot encode both. We need two distinct spellings.

## Decision

The position of the `?` in an array/slice type clause now selects *what* is
nullable. This is a **breaking** redefinition of the existing `[]T?` spelling.

### 1. The two (and a half) spellings

| Spelling | Meaning | Bound type | Indexable? |
| --- | --- | --- | --- |
| `[]T?`   | array of nullable **elements** | `Slice(Nullable(T))` | yes — `a[i]` yields `T?` |
| `[]?T`   | nullable **array** | `Nullable(Slice(T))` | no — needs `!!` / `?[` first |
| `[]?T?`  | nullable array of nullable elements | `Nullable(Slice(Nullable(T)))` | no — `!!` then `a[i]` yields `T?` |

The same rule applies to fixed-length arrays: `[N]T?` is a fixed array of
nullable elements (`Array(Nullable(T), N)`), `[N]?T` is a nullable fixed array
(`Nullable(Array(T, N))`), and `[N]?T?` is both. Jagged element-nullable arrays
follow naturally: in `[][]T?` the trailing `?` binds to the innermost element,
and `[]*T?` is a slice of nullable pointers.

The mnemonic: a `?` **after `]`** marks the array; a `?` **after the element**
marks the element.

### 2. Syntax

`TypeClauseSyntax` gains one token field, `ArrayQuestionToken` (exposed as
`IsArrayNullable`), capturing a `?` placed immediately after `]`. The existing
`QuestionToken` (`IsNullable`) keeps representing the trailing `?`, but for an
array clause it now binds to the **element** rather than the whole array. The
parser captures the after-`]` marker before the element-vs-nested-element
branch, so `[]?T`, `[]?*T`, `[N]?T`, and the element-nullable `[]T?` / `[][]T?`
all parse. Element-nullable array **literals** (`[]T?{…}`, `[N]T?{…}`) route the
element through a nullable-suffixed type clause, reusing the issue #1046 nested
element-clause path.

A nullable array whose element is itself a *slice* (`[]?[]T`) is **not**
spellable, because `?[` lexes as the single null-conditional-index token
(`QuestionOpenBracketToken`, ADR-0073). This corner case is intentionally left
out of scope; `[]?*T` and `[]?Map[K,V]` and the identifier forms cover the
nested-element need.

No new `SyntaxKind` or `BoundNodeKind` is introduced.

### 3. Binding

`ApplyArraySuffix` wraps the element in `NullableTypeSymbol` when the trailing
`?` (`IsNullable`) is present (`[]T?` → `Slice(Nullable(T))`). `BindTypeClause`
no longer wraps the *whole* array for that trailing `?`; instead it wraps the
array in `NullableTypeSymbol` only when the after-`]` marker
(`IsArrayNullable`) is present (`[]?T` → `Nullable(Slice(T))`). Because `[]T?`
now binds to a `SliceTypeSymbol` (not a `NullableTypeSymbol`), the existing
slice element-access path indexes it directly and yields `T?`; the nullable
array `[]?T` remains a `NullableTypeSymbol` and stays non-indexable (GS0116)
until null-forgiven, preserving the prior nullable-array semantics under the new
spelling.

`SliceTypeSymbol` and `ArrayTypeSymbol` now compute their backing CLR array type
from `NullableLifting.GetEffectiveClrType(element)`, so a value-type
element-nullable array `[]int32?` is backed by `Nullable<int32>[]` (and reads
and writes round-trip a nil element), while a reference-type `[]object?` is
backed by `object[]` (the wrapper is a binder-level annotation).

### 4. `cs2gs` translation

The G# printer renders an array reference's own nullability as `[]?T` (the `?`
right after `]`) and an element's nullability as `[]T?` (the element rendering
carries its own trailing `?`). The translator already captures C# array-level
nullability (`T[]?` → `ArrayTypeReference { IsNullable = true }`) and element
nullability (`T?[]` → an `ArrayTypeReference` whose element is nullable), so only
the print position changed. Net effect: C# `T?[]` → `[]T?`, C# `T[]?` → `[]?T`,
C# `T?[]?` → `[]?T?`.

## Consequences

- `func F(a []object?) object? { return a[0] }` and
  `func G(a []int32?) int32? { return a[0] }` now compile and index directly,
  yielding `T?`. Writing a nil and a value into `[]int32?` / `[]object?` and
  reading them back round-trips at runtime.
- `func N(a []?int32) int32 { return a!![0] }` compiles; a bare index on a
  nullable array (`[]?int32`) is still rejected with GS0116, and `a?[i]`
  short-circuits on a nil array as before.
- **Breaking change.** Existing G# that wrote `[]T?` for a *nullable array* must
  migrate to `[]?T`. In-repo usages were migrated: `samples/NullConditionalIndexing.gs`
  and the issue #710/#751/#1154/#1238/#1240 binder/emit/interpreter tests
  (`[]int32?`/`[]uint8?` → `[]?int32`/`[]?uint8`), and the issue #1072 `cs2gs`
  assertions (`[]uint8?` → `[]?uint8`).
- No new `SyntaxKind`/`BoundNodeKind` was added; the coverage matrix and
  exhaustiveness allowlists are unaffected.
