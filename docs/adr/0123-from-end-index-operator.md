# ADR-0123: From-end index operator (`^n`) for index and range bounds

- **Status**: Accepted
- **Date**: 2026-06-23
- **Phase**: Phase 9 — language depth / collection ergonomics
- **Related**: issue #1016 (the `..` range/slice operator), issue [#1022](https://github.com/DavidObando/gsharp/issues/1022)

## Context

Issue #1016 added the C#-style `..` range/slice operator inside an indexer
(`a[lo..hi]`, `a[..hi]`, `a[lo..]`, `a[..]`) for arrays/slices, strings,
span-like values, and `System.Range` indexers. It intentionally **deferred** the
C# "from-end" index operator `^n` (`a[^1]`, `a[..^1]`, `a[1..^1]`), which maps to
`System.Index` with `fromEnd: true`.

The deferral existed because `^` already has two meanings in G#:

- prefix **one's-complement** (`^x`), and
- infix **bitwise-XOR** (`a ^ b`).

Reusing `^` as a leading from-end marker inside `[...]` is genuinely ambiguous
with those meanings and needs a deliberate disambiguation rule.

## Decision

1. **Disambiguation by position.** A `^` is treated as a from-end index marker
   **only in the leading position of an index or range bound** — that is, the
   first token of the single index in `a[^n]`, or the first token of either side
   of a range in `a[^lo..^hi]`. The index-argument parser (`ParseIndexArgument`
   → `ParseIndexBound`) is the only place that recognizes it. Everywhere else —
   including inside the offset expression itself (`a[^(x ^ y)]`), a non-leading
   `^` inside the bracket (`a[i ^ j]`), and any `^` outside `[...]` (`^5`,
   `a ^ b`) — `^` keeps its existing one's-complement / XOR meaning unchanged.

2. **Syntax.** A new `FromEndIndexExpressionSyntax`
   (`SyntaxKind.FromEndIndexExpression`) wraps the `^` token and its offset
   operand. It is produced uniformly for both the bare single-index case
   (`a[^n]`, where it is the index of an `IndexExpressionSyntax`) and as the
   lower/upper bound of a `RangeExpressionSyntax` (`a[1..^1]`, `a[^2..]`). This
   keeps the two surfaces consistent and confines the new grammar to the
   index-argument parser. No new `BoundNodeKind` is introduced.

3. **Binding / lowering.** From-end indices lower to existing bound nodes at bind
   time (mirroring how #1016 lowered ranges), so emit and the interpreter share
   one path:
   - **Single index `a[^n]`** reads `length - n`:
     - arrays/slices (`[N]T`, `[]T`, CLR `T[]`) → `src[len(src) - n]`;
     - a type with a `this[System.Index]` indexer → the indexer is called with
       `System.Index(n, fromEnd: true)` (the runtime resolves the offset);
     - a type with an `int Length`/`int Count` property plus a `this[int]`
       indexer (`string`, `List[T]`, span-like) → `src[Length - n]`.
   - **From-end bound in a range** computes `length - n` at lowering time for the
     array/string/span-like paths; for a `this[System.Range]` indexer it is
     passed through as `System.Index(n, fromEnd: true)` so the BCL indexer
     computes the offset.

## Consequences

- `a[^1]` is the last element, `a[^n]` is `length - n`, and from-end bounds work
  in every range form, matching C# semantics.
- The existing one's-complement and XOR uses of `^` are provably unaffected
  (regression tests assert `^5`, `6 ^ 3`, and `a[i ^ j]` keep their meanings).
- Standalone `System.Range`-producing expressions (`let r = 1..3`) remain
  unsupported and are tracked separately as a follow-up.
