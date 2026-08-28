# ADR-0172: Named tuple elements

- **Status**: Accepted
- **Date**: 2026-08-28
- **Related**: issue #3501 (self-migration readability), ADR-0115 §B.4/T1 (amended by this ADR), ADR-0171 (tuple equality), ADR-0029 (data-struct members), C# §8.3.11 / `TupleElementNamesAttribute`.

## Context

G# tuples were purely positional — ADR-0115 §B.4 stated "the named-element
spelling does not parse" as a premise, and cs2gs accordingly dropped C# element
names: type `(int Line, int Column)` mapped to `(int32, int32)`, access
`t.Line` lowered to `t.Item1`, literal labels were discarded. The #3501
self-migration corpus contains roughly 830 named-tuple declaration lines
across ~300 files, so translated output was full of `item.Item2 * item.Item3`
where the C# said `item.Price * item.Quantity` — contrary to #3501's "fully
readable, maintainable" definition of done, and invisible to the selfmig
ratchet. The loss also crossed the CLR boundary in both directions: gsc
neither emitted nor imported `TupleElementNamesAttribute`.

## Decision

G# gains named tuple elements. **This reverses the ADR-0115 §B.4/T1
positional-only premise**; an amendment note there points here.

### Syntax

- **Tuple types** name elements name-first, matching the parameter form
  `identifier TypeClause`:

  ```gs
  let pos (line int32, column int32) = (3, 5)
  func divmod(a int32, b int32) (quotient int32, remainder int32) { … }
  ```

  Partial naming is allowed (`(count int32, string)`). An identifier is an
  element NAME exactly when it is followed by a token that can start a type
  clause; the `[` case distinguishes `name []T` / `name [3]T` / `name [,]T`
  (array shapes open with `]`, a number, or a rank comma) from a generic
  argument list `List[int32]`, and the `unmanaged` function-pointer head
  keeps its ADR-0095 meaning. The #3315 grouping rule is preserved: there
  are no 1-tuples, and a name on a parenthesized single element is error
  **GS0543**, recovered as grouping.

- **Tuple literals** label elements with a colon, matching the
  argument-label style:

  ```gs
  let t = (line: 7, column: 9)     // infers (line int32, column int32)
  ```

  Labels are optional per element. A lone labeled element `(x: 1)` is
  GS0543, recovered as a plain parenthesized expression. C# 7.1-style name
  inference from expressions is deliberately not adopted.

### Semantics: names are metadata

- The interned `TupleTypeSymbol` is keyed on (element types, element names):
  a named and an unnamed same-shape tuple are **distinct symbol instances
  sharing the same CLR backing**, related by an **identity conversion**
  (`WithoutNames()` computes the canonical unnamed shape, recursively).
  Assignment, argument passing, and returns cross name boundaries freely;
  a position where both sides declare *different* names warns **GS0541**
  (the C# CS8123 analog).
- Member access resolves a declared name to its position; `ItemN` and the
  numeric `.N` selectors remain valid on named tuples. Emit is unchanged —
  access lowers to the positional `ItemN` field either way.
- Declaration checks: duplicate name = **GS0540**; `ItemN` at any position
  other than N and `Rest` = **GS0542** (correct-position `ItemN` is
  allowed, as in C#).
- Names propagate through generic substitution and merge across
  common-type joins by the C# rule (keep agreeing names, drop the rest).
- **Equality (ADR-0171) ignores names** — the desugar compares shape, never
  symbol identity.
- Positional deconstruction, patterns, and `for (a, b) in` are unchanged.

### Phasing

- **Phase A (this change)**: parser, symbol model, member lookup,
  conversions/identity, diagnostics GS0540–GS0543, display.
- **Phase B**: metadata interop — emit `TupleElementNamesAttribute` on
  tuple-typed parameters/returns/fields/properties (C# flattened pre-order
  encoding) and decode it on import, so C#-authored named tuples surface
  their names in G# and vice versa.
- **Phase C**: cs2gs preserves names end-to-end (type mapping, printer,
  member access, literal labels) + corpus/selfmig re-baseline.
- **Phase D**: language-server polish (hover, element-name completion).

## Alternatives rejected

- **Names on references, not symbols** — G# has no annotation channel on
  `BoundExpression` types; every consumer sees a bare `TypeSymbol`. The
  wrapper-symbol precedent (`NullableTypeSymbol`) confirms symbols are the
  annotation channel.
- **Nominal named tuples** (names part of type identity) — breaks C#
  interop semantics and every existing positional conversion.

## Future work (not planned)

Deconstruction-by-name, named positional patterns, C# 7.1 name inference.
