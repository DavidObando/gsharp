# ADR-0171: Tuple equality operators (`==` / `!=`) as a bind-time element-wise desugar

- **Status**: Accepted
- **Date**: 2026-08-28
- **Related**: issue #3501 (self-migration; the Core.Tests wall's 2×GS0129), ADR-0029 (data-struct synthesized equality), ADR-0159 (nil comparison), ADR-0115 (cs2gs), C# §12.12.10 (tuple equality operators).

## Context

G# had no equality over tuple operands. `(a, b) == (c, d)` fell through the
entire binary-operator cascade — the built-in operator table, user-defined
`operator` methods, CLR `op_*` resolution (`System.ValueTuple` declares no
`op_Equality`), and the #2188 reference-equality last resort (tuples are value
types) — to GS0129. cs2gs translates C# `==`/`!=` verbatim, so the migrated
`GSharpAnalyzerVerifier` comparison `(actualLine, actualColumn) !=
expectedLocations[i]` kept Core.Tests red in the #3501 nightly gate.

## Decision

`t1 == t2` and `t1 != t2` are defined whenever **both** operand types are
tuple types of **equal arity** (arity mismatch is the new error **GS0539**;
a tuple against a non-tuple still falls through the ordinary cascade to
GS0129). The operator binds as a **bind-time desugar** into a
`BoundBlockExpression`:

```
$tupeqL = t1                     // readonly temp — operand evaluated once
$tupeqR = t2
$tupeqL.Item1 == $tupeqR.Item1 && … && $tupeqL.ItemN == $tupeqR.ItemN
```

- `!=` folds the element-wise `!=` comparisons with `||`.
- The fold is left-associated, so evaluation order matches C#: `t1` is
  evaluated exactly once, then `t2` exactly once, then the element
  comparisons run left-to-right with `&&`/`||` short-circuit.
- Each element pair binds through the **ordinary equality chain** — built-in
  table with numeric adaptation, user-defined and CLR `op_*` operators,
  reference-equality last resort, and nested-tuple recursion. User-declared
  element `operator ==`, string equality, and lifted `T?` elements therefore
  behave exactly as they do outside a tuple. An incomparable element pair
  reports GS0129 with the *element* types; every failing pair is reported,
  not just the first.
- Arity and element types are compared **structurally** — never by
  `TupleTypeSymbol` reference identity — so the desugar is insensitive to
  future same-shape symbol distinctions (ADR-0172 named tuple elements).
  Element names, when they exist, are ignored, as in C#.
- The result type is `bool`. No new bound node, lowering pass, or emitter
  arm is introduced; the async spiller and emitter already handle the block
  shape. Expression-tree lambdas reject the construct (GS0473), matching C#.

## Alternative rejected

Dispatching to `ValueTuple.Equals` / `EqualityComparer<T>.Default` (the shape
of ADR-0029's data-struct arm) was rejected: it would bypass user-declared
per-element `operator ==`, diverge from C#'s specified element-wise semantics,
and lose short-circuit evaluation.

## Follow-ups (out of scope)

- Nullable tuple operands `(T1, T2)?` with lifted semantics (both nil → `==`
  true; one nil → false; else element-wise).
- `nil` elements inside tuple-literal operands (requires target-typed tuple
  literal binding).
- Comparing tuple literals without materializing the temp tuples (a pure
  optimization; semantics are unchanged).
- Constant folding of all-constant tuple comparisons.
- An element-ordinal-carrying diagnostic (today an incomparable element
  reports GS0129 at the operator token).
