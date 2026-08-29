# ADR-0173: Generalized variadic carriers (`...X[T]` ≡ C# `params X<T>`)

- **Status**: Accepted
- **Date**: 2026-08-28
- **Related**: issue #3627 (the `params ReadOnlySpan<T>` cs2gs gap — the last Cs2Gs.Tests translate wall in #3501's selfmig nightly), ADR-0101/0102 (variadic params), ADR-0115 (cs2gs), C#13 params collections (§12.6.4.4).

## Context

ADR-0101's variadic model was array-only: `name ...T` declares a
`params T[]` member (slice `[]T` in the body, `[ParamArrayAttribute]` in
metadata). C#13 generalized `params` to collection types — with
`params ReadOnlySpan<T>` as the compiler's *preferred* expanded-call
overload — and G# had no counterpart, so cs2gs gapped every such callee
(`CS2GS-GAP: params collection of type 'System.ReadOnlySpan<int>' has no
gsc construction form`).

## Decision

The type written after `...` is now interpreted like C#'s params type:

- **If it is a supported collection shape, it is the CARRIER** — the exact
  parameter type the callee receives and the CLR signature declares; its
  single type argument is the element type:
  - `...[]T` ≡ `params T[]` (explicit array carrier; `...[][]T` ≡ `params T[][]`)
  - `...List[T]` ≡ `params List<T>`
  - `...IEnumerable[T]` / `...ICollection[T]` / `...IList[T]` /
    `...IReadOnlyCollection[T]` / `...IReadOnlyList[T]` ≡ the matching
    `params I…<T>`
  - `...Span[T]` / `...ReadOnlySpan[T]` ≡ `params (ReadOnly)Span<T>`
- **Otherwise it stays the ADR-0101 ELEMENT type** with an implicit slice
  carrier: `...int32` ≡ `params int[]`, and `...HashSet[int32]` remains a
  params array OF `HashSet<int32>` elements.

  The carrier set is a deliberately CLOSED allowlist, unlike C#13's
  open-ended rule (any collection-expression target — anything with an
  accessible `Add` + `IEnumerable`, or a `[CollectionBuilder]` factory —
  qualifies, so `params HashSet<int>` is legal C#). Two reasons:

  1. **The spelling is already taken.** Under ADR-0101 every `...X` means
     "params array of `X` elements", and passing whole collections AS
     elements is legitimate (`countSets(a, b)` over `...HashSet[int32]`).
     The allowlisted shapes were safe to reinterpret precisely because
     nobody plausibly passes a bare `List[T]`/span/IEnumerable-interface
     value as ONE element of a params list; adopting C#'s open rule would
     make every collection-ish type ambiguous between carrier and
     element.
  2. **No general packing recipe.** Each allowlisted carrier has a known
     construction form gsc can emit at the call site (array as-is,
     interface upcast, `new List<T>(T[])`, span `T[]` ctor). Arbitrary
     collection targets need C#'s full collection-expression lowering
     (create empty, loop `Add`), which gsc does not have — that machinery
     is the prerequisite for ever widening the allowlist (see out of
     scope).

  Consequently a C# `params X<T>` whose `X` is outside the allowlist has
  NO G# spelling; cs2gs reports a translation gap rather than silently
  changing the declaration's meaning.

Call-site semantics mirror C# exactly: expanded trailing arguments are
coerced to the element type (the #1493 rules) and packed into the carrier;
a single trailing argument already implicitly convertible to the carrier
passes through unchanged. Packing constructs:

- array family — the existing fresh array (unchanged);
- interface carriers — the packed array upcast (arrays implement all five);
- `List[T]` — `new List<T>(T[])`;
- span carriers — the span's `T[]` constructor (heap-allocating v1;
  a stackalloc/inline-array lowering can come with a future span design,
  which this ADR deliberately does NOT introduce — no magic `span` type,
  no readonly sigil).

**Metadata**: array carriers keep `[ParamArrayAttribute]`; every other
carrier stamps C#13's `[ParamCollectionAttribute]`, so C# consumers see a
genuine `params X<T>` member.

**Coverage**: every ADR-0101/0102 declaration site takes carriers through
one shared resolver — free functions, methods, constructors, primary
constructors, interface methods, named delegates, lambdas, and
function-type clauses (`(...List[int32]) -> R`).

**Diagnostics**: **GS0544** when a List/span carrier's element is a
same-compilation (erased) type with no closed CLR construction shape at
the call site — use the array carrier there.

**cs2gs** (ADR-0115 amendment): `params X<T>` declarations translate to
`...X[T]` for supported carriers (spans included — retiring the #3627
gap); expanded call sites on SOURCE-DECLARED callees stay in natural form
(gsc packs); referenced/BCL callees keep the pre-existing lowerings.
`params List<int>[]` / `params byte[][]` (array of a carrier-shaped
element) print the explicit spellings `...[]List[int32]` /
`...[][]uint8`, since the bare forms would reinterpret the element as
the carrier.

## Breaking-change note

`...X` where `X` is a carrier shape is REINTERPRETED (previously: params
array of `X` elements). No in-tree G# used such spellings; the escape
hatch for the old meaning is the explicit array carrier (`...[]X`).
Bare `...T` for non-collection `T` — the only spelling in real use — is
unchanged.

## Out of scope (recorded follow-ups)

- Import-side expansion of `[ParamCollection]` members: G# call sites can
  pass a collection to an imported params-collection member in normal
  form, but cannot yet call it EXPANDED (same-compilation callees can).
  Includes C#13 span-preferred betterness ordering.
- A first-class `span` magic type (`span T` / read-only modifier) — design
  discussion lives in #3627.
- Widening the carrier allowlist toward C#'s open collection-expression
  rule: requires collection-expression lowering in gsc plus either an
  explicit carrier sigil or a per-type no-element-usage audit (see the
  closed-allowlist rationale above).
