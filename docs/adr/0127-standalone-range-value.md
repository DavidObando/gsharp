# ADR-0127: Standalone `System.Range` value (`let r = 1..3`)

- **Status**: Accepted
- **Date**: 2026-06-24
- **Phase**: Phase 9 — language depth / collection ergonomics
- **Related**: issue #1016 (the `..` range/slice operator), issue #1022 (the from-end `^n` marker, [ADR-0123](0123-from-end-index-operator.md)), issue [#1038](https://github.com/DavidObando/gsharp/issues/1038)

## Context

Issue #1016 added the C#-style `..` range/slice operator **inside an indexer**
(`a[lo..hi]`, with the open forms `a[..hi]`, `a[lo..]`, `a[..]`) and issue #1022
([ADR-0123](0123-from-end-index-operator.md)) added the from-end `^n` marker in
the leading position of an index/range bound. Both intentionally **deferred** a
standalone `System.Range`-producing expression:

```gsharp
let r = 1..3        // r : System.Range
let s = a[r]        // index by a Range value
```

Lifting `..` into the general expression grammar requires choosing a precedence,
binding the four open forms to a constructed `System.Range`, deciding how the
from-end `^` marker behaves where a leading `^` is ambiguous with one's-complement,
and allowing a `System.Range`-typed value to be used as an index argument.

## Decision

1. **Grammar / precedence.** A standalone range is a new expression layer
   (`ParseRangeExpression`) sitting directly under the assignment/ternary tail
   and above null-coalescing. Each bound is a full null-coalescing expression, so
   **`..` binds looser than every binary operator**: `1+2..3+4` parses as
   `(1+2)..(3+4)`, matching the issue's stated requirement. All four open forms
   (`lo..hi`, `lo..`, `..hi`, `..`) are supported. An open upper bound (`lo..`)
   terminates at a closing delimiter, a separator, or a **line break**, so
   `let r = 1..` on its own line is the open range `1..end` rather than a
   continuation onto the next statement.

2. **No interference with the index grammar.** Inside an index bracket the `..`
   token is owned by the index-argument parser (`ParseIndexArgument` /
   `ParseIndexBound`), exactly as in #1016/#1022. The standalone range layer is
   suppressed while parsing an index bound (a `suppressRangeOperator` depth
   counter), so `a[lo..hi]`, `a[^2..]`, and `a[a..^b]` parse byte-for-byte as
   before. The counter is re-cleared inside parentheses and argument lists, so a
   parenthesised or argument-position range nested in an index bound
   (`a[(1..3)]`, `a[f(1..3)]`) is still recognised as a standalone value.

3. **From-end `^` restriction.** A from-end `^n` marker is supported in the
   **upper** bound of a standalone range (`lo..^hi`, `..^hi`), where it is
   unambiguous because it immediately follows `..`. A **leading** `^` at the very
   start of a standalone range (`^a..b`) is **not** supported: the parser reads
   `^a` as the one's-complement unary operator, and the binder reports the new
   **GS0410** diagnostic so the from-end intent is not silently misread. To slice
   from the end, index the value directly (`arr[^a..]`, the #1022 path); to use a
   one's-complement value as a from-start lower bound, parenthesise it
   (`(^a)..b`).

4. **Binding / lowering.** A standalone range binds to `new System.Range(start,
   end)`, where each bound is a `System.Index`: a plain value `v` → `Index(v)`
   (from-start), a `^n` marker → `Index(n, fromEnd: true)`, an open lower → the
   start, an open upper → the end. This mirrors how C# lowers a range expression
   and reuses the same `BuildSystemRangeValue` helper as the #1016
   `this[System.Range]` indexer path. The value is typed `System.Range`. No new
   `BoundNodeKind` is introduced.

5. **Indexing by a range value (`a[r]`).** A `System.Range`-typed value used as
   an index argument slices the receiver with the *same* shapes as the syntactic
   `a[1..3]` form — arrays/slices copy via `Array.Copy`, `string` uses
   `Substring`, span-like values use `Slice`, and a `this[System.Range]` indexer
   is called with the value directly. The concrete `start`/`length` are resolved
   from the range value at runtime via `System.Index.GetOffset(length)`. The
   index expression is bound once and reused across the ordinary index paths to
   avoid re-binding; `default`/interpolated index syntaxes (which can never be a
   range value) keep their dedicated conversion handling.

## Consequences

- `let r = 1..3` gives `r : System.Range`; all four open forms bind, emit, and
  evaluate; `a[r]` slices arrays, `[]T` slices, strings, and span-like values
  (and any `this[System.Range]` type), matching C# semantics.
- The #1016/#1022 index-bracket forms are unaffected (regression tests assert
  `a[1..^1]`, `a[..^3]`, `a[^2..]` are unchanged), and the existing
  one's-complement/XOR uses of `^` keep their meaning.
- The one genuinely ambiguous position — a leading `^` in a standalone range —
  is rejected with a clear, actionable diagnostic (GS0410) rather than silently
  misinterpreted.

## Deferred

None. The standalone range is implemented end-to-end (parse, bind, emit,
interpret, and `a[r]` indexing across all supported receiver shapes).
