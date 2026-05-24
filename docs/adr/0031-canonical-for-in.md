# ADR-0031: Canonical `for x in collection`

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 7.2
- **Related**: execution plan row 7.2; ADR-0021 contextual variance keywords; ADR-0023 `await for v := range stream`

## Context

Phase 7.2 adds a canonical collection-iteration spelling. GSharp already supports the Go-inspired `for v := range coll` spelling from Phase 4 and `await for v := range stream` from Phase 5.8 / ADR-0023, but users coming from Kotlin, C#, Python, and similar languages expect `for x in collection` and `await for x in stream`. The existing range binder already knows how to iterate arrays, slices, CLR dictionaries, CLR `IEnumerable[T]`, non-generic CLR `IEnumerable`, and async streams. Adding pattern-based `GetEnumerator()` also lights up user-defined and imported CLR iterables that intentionally expose the standard foreach pattern without implementing `IEnumerable[T]`.

## Decision

Accept `for x in coll`, `for k, v in dict`, and `await for x in stream` as the canonical iteration forms. `in` is a contextual keyword recognized only in the for-header position, mirroring the ADR-0021 precedent for contextual `in` and `out` variance markers, so `in` remains valid as an ordinary identifier elsewhere. The legacy `:= range` spellings continue to parse and bind for backward compatibility, but new code should prefer `in`. Both spellings route through the same binder helper and produce the same `BoundForRangeStatement` or `BoundAwaitForRangeStatement`, so downstream lowering, evaluation, and emit do not grow a parallel for-in tree. Pattern-based `GetEnumerator()` joins the accepted discriminant set: a public instance parameterless `GetEnumerator()` must return an enumerator with public instance `bool MoveNext()` and a public `Current` property or field; the element type is the static type of `Current`.

## Rationale

The `in` spelling is familiar from Kotlin, C#, Python, and other mainstream languages and reads more naturally for non-Go users. Keeping `:= range` preserves all shipped Phase-4 and Phase-5 tests and samples while allowing documentation and new examples to converge on one canonical form. Treating `in` as contextual avoids breaking existing code that uses `in` as a variable or parameter name and is consistent with ADR-0021's contextual-keyword design. Pattern-based foreach support lets GSharp iterate custom CLR and GSharp types that deliberately expose a foreach-compatible shape without taking a dependency on `IEnumerable[T]`.

## Consequences

The parser gains a small for-header disambiguation between legacy `:= range` and contextual `in`. The binder accepts pattern-based foreach in addition to the previous array, slice, dictionary, enumerable, and async-stream cases. The legacy `:= range` spellings are documented as candidates for removal in a future major-version cleanup, but no removal happens in this phase. Samples and docs should migrate toward `in` where appropriate while retaining compatibility tests for `:= range`.

## Alternatives considered

Removing `:= range` immediately was rejected because it would break the Phase-4 and Phase-5 surface that has already shipped and would invalidate existing tests and samples unnecessarily.

Reserving `in` as a hard keyword was rejected because it would break any user code using `in` as an identifier and would be inconsistent with ADR-0021's contextual-keyword precedent.
