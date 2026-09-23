# ADR-0126: Increment / decrement as value-producing expressions (`++` / `--`)

- **Status**: Accepted
- **Date**: 2026-07-03
- **Amended**: 2026-09-22 — writable ref results, floating-point operands,
  exact postfix capture, and once-only receiver/index evaluation
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

### 1. Parser-level desugar onto compound-assignment forms

Increment/decrement-as-expression remains a parser desugar rather than a
dedicated increment/decrement bound node. The parser routes each target through
the compound-assignment form that already owns its storage semantics:

The parser recognises:

- **Prefix** `++operand` / `--operand` in prefix-expression position.
- **Postfix** `operand++` / `operand--` in postfix-expression position (after
  the member/index/`!!` chain has been parsed).

- a bare name or member access uses the general member/compound dispatcher
  (`EventSubscriptionExpressionSyntax`, whose historical name also covers
  non-event compound writes);
- an indexed target uses `CompoundIndexAssignmentExpressionSyntax`;
- a pointer dereference or call result uses
  `IndirectCompoundAssignmentExpressionSyntax`.

Each form carries whether the expression must return the pre-write value.
Writable native or imported `ref`-returning calls are valid targets. A
by-value call result, literal, binary expression, or other non-storage
expression remains invalid and reports the normal lvalue diagnostic or
**GS0402** (`ReportInvalidIncrementDecrementTarget`).

### 2. Pre/post value semantics

Assignment expressions yield the **new** value, which is the prefix result.
Postfix does not reconstruct the old value with inverse arithmetic. The binder
captures the target's value in a synthesized local, performs one write, and
returns the captured local. This remains exact at floating-point precision
boundaries such as `2^53`, where adding one may round back to the same stored
`float64` value.

The synthetic literal `1` participates in the same numeric adaptation and
conversion-back rules as `target += 1` / `target -= 1`. Floating-point operands,
small integer operands, pointers, and applicable user-defined compound
`+=`/`-=` operators therefore follow their established compound-assignment
semantics. G# does not introduce a separate user-declarable `operator ++` or
`operator --` surface.

### 3. Single evaluation and short-circuit correctness

The operand is evaluated once:

- variables and writable ref-returning calls capture one storage address;
- setter-based properties capture the receiver and pre-write getter value,
  then invoke the setter once;
- array/slice element member writes capture the element address;
- indexers and maps capture their receiver and index arguments.

Because the whole construct remains one expression, a postfix/prefix inside a
short-circuited operand (`a && i-- > 1`) mutates only when that operand is
evaluated.

### 4. Statement form preserved

A bare `i++` / `i--` in statement position is still intercepted by the existing
`ParseIncrementDecrementStatement` fast-path **before** expression parsing, so
the statement form is byte-identical (no regression). Complex statement targets
such as `a[i]++` now also work, routed through the new expression path.

## Consequences

- `var j = i--`, `var k = ++i`, `while i > 0 && i-- > 1 { }`, and short-circuit
  `a && i-- > 1` all compile and run with C# semantics — the deliverable of
  #1027.
- Prefix and postfix `++`/`--` are supported on assignable numeric storage:
  variables, fields, properties, array/slice elements, indexers, maps,
  pointers, and writable ref-returning calls.
- A new diagnostic **GS0402** flags a non-assignable operand. Read-only (`let`)
  operands continue to report the existing assignment diagnostic (GS0127).
- Postfix returns the exact pre-write value for integer and floating-point
  targets, with receiver and index side effects evaluated once.

## Deferrals (follow-up issues, reference #1027)

- Dedicated user-declarable `operator ++` / `operator --` declarations remain
  out of scope; increment/decrement reuses compound `+= 1` / `-= 1` resolution.
- Increment/decrement does not imply atomicity; callers still use the existing
  synchronization/interlocked APIs when concurrent mutation requires it.
