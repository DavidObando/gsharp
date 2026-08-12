# ADR-0164: Native CLR rectangular arrays

- **Status**: Accepted
- **Date**: 2026-08-12
- **Phase**: Phase 9 — language and CLR interop completeness
- **Related**: ADR-0015 (multi-target assignment), ADR-0016 (slice storage), ADR-0020 (generic brackets), ADR-0073 (null-conditional indexing), ADR-0087 (reified generic emit), ADR-0130 (runtime SZ-array allocation), ADR-0132 (nullable array spelling), ADR-0141 (expression trees), issues [#1893](https://github.com/DavidObando/gsharp/issues/1893), [#1954](https://github.com/DavidObando/gsharp/issues/1954), [#3347](https://github.com/DavidObando/gsharp/issues/3347), [#3354](https://github.com/DavidObando/gsharp/issues/3354)

## Context

G# supported only single-dimensional zero-based arrays and slices. CLR
rectangular arrays (`T[,]`, `T[,,]`, and higher ranks) therefore could not be
represented faithfully. Imported signatures lost rank, element access could
drop indices, and `cs2gs` had to flatten selected local arrays into rank-one
storage with synthetic `gDimN` locals and hand-written bounds arithmetic.
Fields, parameters, returns, aliases, and arbitrary imported APIs remained
representation gaps.

CLR rectangular arrays have observable semantics that flattening cannot safely
approximate: rank is part of type identity; each dimension has independent
bounds; allocation, indexing, and element mutation have defined left-to-right
evaluation and exception behavior; storage is row-major; value-type elements
support managed addresses; reference arrays retain runtime store checks; and
metadata signatures use ECMA-335 ARRAY shapes rather than SZARRAY.

## Decision

### Syntax and types

- `[,]T`, `[,,]T`, … spell rectangular array types of rank 2 through 32.
- `[,]?T` makes array reference nullable. Element nullability remains on `T`.
- `[d0, d1]T`, `[d0, d1, d2]T`, … allocate zero-initialized rectangular arrays.
- `a[i, j]` and `a[i, j, k]` read or address one element.
- `[2, 3]T{e00, e01, e02, e10, e11, e12}` is flat row-major initializer form.
  Non-empty initializers require non-negative constant dimensions whose product
  equals initializer count. Empty/no initializer forms allow runtime dimensions.
- Existing `[]T`, `[n]T`, `[n][]T`, and `[][]T` SZ/slice/jagged forms do not
  change.

Comma-separated rank, dimension, and index lists are represented explicitly in
syntax and bound trees. Generic argument commas remain generic arguments because
generic names are recognized from receiver/type context, not comma count alone.

`RectangularArrayTypeSymbol(element, rank)` is interned. Element type and rank
participate in identity, equality, substitution, inference, display, nullable
flags, and structural keys. Runtime dimension lengths do not.

### Binding and semantics

Every dimension and index converts to `int32`. Index arity must equal array rank.
Reads, simple writes, compound writes, increment/decrement, struct-element
addresses, null-conditional reads, and multi-target assignment all preserve
target and index storage.

Evaluation order is:

1. array/receiver,
2. dimensions or indices from left to right,
3. assigned/initializer value.

Every operand is evaluated once. Async lowering spills every dimension, index,
and initializer operand across suspension. Multi-target assignment prepares
each target in source order before evaluating right-hand values.

CLR provides zero initialization, row-major layout, per-dimension bounds,
negative-dimension failure, reference-array store checks, and null behavior.
Bare non-null rectangular slots synthesize an empty array with every dimension
set to zero, matching other ADR-0159 magic-collection zero values; `[,]?T`
retains `nil` as its zero value.
`Length`, `Rank`, `GetLength`, `len`, and `for … in` use `System.Array`
semantics; rectangular `for … in` enumeration is row-major.

### Metadata and emit

Rectangular signatures encode ECMA-335 ARRAY with rank and zero lower bounds.
Imported reflection types with `GetArrayRank() > 1` map to native rectangular
symbols. G#-declared fields, properties, parameters, returns, generic
instantiations, and TypeSpec signatures round-trip through CLR metadata.

Emit uses CLR array pseudo-methods on a TypeSpec parent:

- `.ctor(int32, …)` for allocation,
- `Get(int32, …)` for reads,
- `Set(int32, …, T)` for writes,
- `Address(int32, …)` for managed element addresses.

`len` calls `System.Array.get_Length`; `ldlen` remains limited to SZ arrays.
Expression trees use `Expression.NewArrayBounds` and
`Expression.ArrayAccess`. Rectangular initializer expression trees are rejected
with existing `GS0473` until expression-tree block initialization is supported;
they are never silently emitted as uninitialized arrays.

### `cs2gs`

C# rectangular types, explicit/implicit/target-typed creation, initializers,
element reads/writes, fields, properties, parameters, returns, aliases, and
imported APIs translate directly to native G# shapes. Flat backing arrays,
`gDimN` locals, inline bounds checks, duplicate-index spills, tracked-local
state, and `GetLength` substitutions are removed. Fallback remains only for C#
constructs that G# still cannot express, not for rectangular array
representation.

## Diagnostics

| ID | Meaning |
|---|---|
| GS0527 | Index expression count does not match rectangular array rank. |
| GS0528 | Rank exceeds CLR maximum 32. |
| GS0529 | Non-empty initializer dimensions are not non-negative `int32` constants. |
| GS0530 | Flat initializer count does not equal dimension product. |

## Consequences

- G# consumes and exports arbitrary supported CLR rectangular array ranks.
- Generated IL is verifier-valid and uses CLR-native exception, address, and
  storage behavior.
- Jagged and SZ array source and metadata behavior remain compatible.
- `cs2gs` output is smaller, readable, and valid for locals and non-local
  rectangular arrays without synthetic bookkeeping.
