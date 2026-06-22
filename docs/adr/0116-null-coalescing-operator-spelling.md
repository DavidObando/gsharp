# ADR-0116: Null-coalescing operator spelled `??` (replacing `?:`)

- **Status**: Accepted
- **Date**: 2026-06-22
- **Phase**: Phase 9 — language depth / null-handling ergonomics
- **Related**: ADR-0001 (null model), ADR-0072 (`??=` null-coalescing compound assignment), ADR-0084 (Optional/Sequences extensions), issue [#941](https://github.com/DavidObando/gsharp/issues/941)

## Context

G# originally spelled the binary null-coalescing **read** operator as `a ?: b`
(the "Elvis" operator, introduced under ADR-0001 / Phase 3.C.3): evaluate `a`;
if it is non-nil yield `a`, otherwise evaluate and yield `b`. Short-circuit
semantics guarantee `b` is only evaluated when `a` reads as nil.

When the null-coalescing **compound assignment** `a ??= b` was added under
ADR-0072 (issue #709), it deliberately adopted the C# spelling (`??=`) while the
**read** retained the divergent `?:` spelling. This left G# with two
inconsistent spellings for the same concept:

- read: `a ?: b`
- assign-if-nil: `a ??= b`

C#, TypeScript/JavaScript, Swift, Kotlin (`?:` is Kotlin-only), and most of the
adjacent ecosystem spell the null-coalescing read as `a ?? b`, with `??=` as the
compound form. The `?:` spelling also visually collides with the ternary
conditional `cond ? a : b` (ADR-0062), which G# also supports — `a ?: b` reads
like a "ternary with an empty true-arm", which it is not.

Issue #941 resolves the inconsistency by making the read operator `??`, matching
`??=` and the broader ecosystem.

## Decision

1. **`a ?? b` is the binary null-coalescing operator.** It carries exactly the
   semantics, binding, lowering, and emit that `?:` previously had
   (`BoundBinaryOperatorKind.NullCoalesce`): evaluate `a`; if non-nil, yield `a`;
   otherwise evaluate and yield `b`. The right operand is evaluated lazily. The
   result type is the best common type of the operands (`T` when `b` is
   non-nullable `T`, `T?` when `b` is itself `T?`). Works for nullable reference
   types and `Nullable<T>` value types.

2. **The `?:` spelling is removed entirely.** The lexer no longer produces a
   `QuestionColonToken`; the `SyntaxKind.QuestionColonToken` member is renamed to
   `QuestionQuestionToken`. Any source that writes `a ?: b` now fails to parse
   (GS0005). This is an **intentional breaking change** with no soft-phasing —
   all in-repo consumers (samples, tests, golden files, SDK `.gs` sources, the
   spec, and the cs2gs migration tool) are migrated to `??` in the same change.

3. **Precedence and associativity match C#.** `??` is **right-associative** and
   sits at a precedence strictly **below `||`** (logical or) and **above** the
   ternary conditional. Thus `a ?? b ?? c` parses as `a ?? (b ?? c)`, and
   `a ?? b ? c : d` parses as `(a ?? b) ? c : d`. The parser handles `??` in a
   dedicated `ParseNullCoalescingExpression` layer between the
   (left-associative) binary-operator loop and the ternary/assignment tail,
   rather than inside the binary precedence table, so it can be right-associative
   while remaining lower-precedence than every left-associative binary operator.

4. **`??=` is unchanged.** The compound assignment from ADR-0072 keeps its
   spelling, lowering, and statement-only status.

## Consequences

### Positive

- One consistent spelling for the null-coalescing family (`??` read, `??=`
  assign), matching `??=` and the C#/TS/JS ecosystem; lower learning curve.
- Removes the visual collision between `?:` and the ternary `? :`.
- Reuses the entire existing `NullCoalesce` binder/lowering/emit machinery — the
  change is concentrated in the lexer, parser, and the single operator-token
  check in `BoundBinaryOperator.Bind`.

### Negative

- Breaking change: existing `?:` source no longer compiles. Accepted per issue
  #941 ("all current consumers are aware of this breaking change and we do not
  need any soft-phasing of the switch").

### Neutral

- ADR-0001, ADR-0072, and ADR-0084 retain their historical narrative; their
  inline operator references are updated to `??` and annotated to point here.
- The cs2gs migration tool now emits `??` for C# `??` (previously surfaced as an
  unsupported gap — ADR-0115).

## Alternatives considered

- **Keep both `?:` and `??` as synonyms.** Rejected: dual spellings perpetuate
  the inconsistency and complicate the lexer/parser/spec indefinitely. Issue #941
  explicitly calls for removing `?:`.
- **Spell the read `?:` and the assign `?:=`.** Rejected: diverges from the
  entire ecosystem and keeps the ternary collision; `??=` already shipped.
