# ADR-0126: Increment / decrement as value-producing expressions (`++` / `--`)

- **Status**: Accepted
- **Date**: 2026-07-03
- **Phase**: Phase 9 — language ergonomics / C# parity
- **Related**: ADR-0072 (null-coalescing compound assignment), ADR-0121 (throw expressions), issue [#1027](https://github.com/DavidObando/gsharp/issues/1027)

## Context

G# already accepted `i++` and `i--` as **statements** (an `IncDecStmt`), which
the parser desugars to the assignment `i = i + 1` / `i = i - 1`. They could not
be used as **expressions**, so value positions such as `var j = i--`,
`while i > 0 && i-- > 1 { }`, and short-circuited `a && i-- > 1` failed to parse
with `GS0005`. Because the mutation lives inside a short-circuited/branching
expression, it cannot be hoisted to a separate statement — the expression form
is required to express the C# semantics.

C# semantics: the **postfix** form `i++` yields the value **before** mutation;
the **prefix** form `++i` yields the value **after** mutation.

## Decision

### 1. Parser-level desugar — no new bound/syntax node

Increment/decrement-as-expression is implemented as a **pure parser desugar**
onto the existing value-producing assignment expressions, mirroring how the
statement form and compound assignments (`+=`, `-=`, …) are already desugared in
this codebase. **No** new `SyntaxKind` or `BoundNodeKind` enum value is
introduced, so the binder, lowerer, emitter, coverage matrix, and
`BoundNodeKindExhaustivenessTests` are untouched. This is the lowest-risk design
and reuses 100% of the assignment binding/lowering/emit, including its existing
lvalue/assignability checks and diagnostics.

The parser recognises:

- **Prefix** `++operand` / `--operand` in prefix-expression position.
- **Postfix** `operand++` / `operand--` in postfix-expression position (after
  the member/index/`!!` chain has been parsed).

The operand is lifted to the appropriate **assignment** syntax:

- a bare name → `AssignmentExpressionSyntax` (`x = x ± 1`);
- a member access `recv.field` → `FieldAssignmentExpressionSyntax` when the
  receiver is a bare name (so a value-type struct receiver is addressed via
  `ldloca` and the mutation is observed), else `MemberFieldAssignmentExpressionSyntax`;
- an indexed target `recv[i]` → `CompoundIndexAssignmentExpressionSyntax`, which
  binds through the single-evaluating indexed-write chain.

If the operand is not an assignable lvalue (e.g. `5++`, `(a + b)--`, a call
result), the parser reports the new **GS0402**
(`ReportInvalidIncrementDecrementTarget`).

### 2. Pre/post value semantics

Assignment expressions in G# yield the **new** (assigned) value (`dup` + store).
That is exactly the prefix result, so:

- **Prefix** `++operand` desugars to the assignment `operand = operand + 1`
  (resp. `- 1`) and yields the new value directly.
- **Postfix** `operand++` desugars to `(operand = operand + 1) - 1` (resp.
  `(operand = operand - 1) + 1`): perform the prefix assignment, then apply the
  inverse arithmetic to recover the **old** value.

This `(new) ∓ 1` reconstruction is **exact** because increment/decrement in G#
is integer-only: the literal `1` is `int32` and does not implicitly convert to a
floating-point operand, so `f++` on a `float64` already fails (`GS0129`). There
is therefore no floating-point rounding gap, and the old value is recovered
losslessly.

### 3. Single evaluation and short-circuit correctness

The operand is evaluated once: the indexed form routes through the existing
single-evaluating indexed-write chain (the array/map **receiver** is spilled to
a temp and not re-evaluated), and the member form addresses the receiver in
place. Because the whole construct is a single expression that the binder places
exactly where it was written, a postfix/prefix inside a short-circuited operand
(`a && i-- > 1`) mutates **only** when that operand is actually evaluated — the
decrement is never hoisted out of the short-circuited branch.

> **Index argument double-evaluation** matches the pre-existing compound
> assignment behaviour: `a[idx()]++` evaluates `idx()` twice, identical to
> `a[idx()] += 1`. The array/map *receiver* chain is single-evaluated. This is
> consistent with existing `+=` semantics and is not a regression introduced
> here.

### 4. Statement form preserved

A bare `i++` / `i--` in statement position is still intercepted by the existing
`ParseIncrementDecrementStatement` fast-path **before** expression parsing, so
the statement form is byte-identical (no regression). Complex statement targets
such as `a[i]++` now also work, routed through the new expression path.

## Consequences

- `var j = i--`, `var k = ++i`, `while i > 0 && i-- > 1 { }`, and short-circuit
  `a && i-- > 1` all compile and run with C# semantics — the deliverable of
  #1027.
- Prefix and postfix `++`/`--` are supported on every assignable numeric lvalue:
  variable, field, array element, and indexer target.
- A new diagnostic **GS0402** flags a non-assignable operand. Read-only (`let`)
  operands continue to report the existing assignment diagnostic (GS0127).
- **No** new `SyntaxKind`/`BoundNodeKind` — coverage matrix and exhaustiveness
  allowlists are unchanged.

## Deferrals (follow-up issues, reference #1027)

- **Pointer `++`/`--`** (post-#1014 pointer arithmetic): deferred; numeric
  lvalues are the must-have and are fully implemented.
- **Index-argument single-evaluation** for `a[f()]++`: tracks the analogous
  pre-existing compound-assignment limitation rather than this feature.
