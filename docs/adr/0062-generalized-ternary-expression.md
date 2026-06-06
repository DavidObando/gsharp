# ADR-0062: Generalized ternary expression — `cond ? ifTrue : ifFalse`

- **Status**: Accepted
- **Date**: 2026-06-05
- **Implemented**: 2026-06-05 (PR [#497](https://github.com/DavidObando/gsharp/pull/497))
- **Phase**: Phase 8 — language ergonomics / expression surface
- **Related**: issue #495 (limited ref-only ternary), ADR-0061 (conditional ref-arguments), ADR-0060 (`ref`/`out`/`in` parameters), ADR-0058 (ref-safe-to-escape), ADR-0037 (numeric tie-breaking)

## Context

G# currently has no general value-producing two-arm conditional expression. ADR-0061 introduced `cond ? a : b` only in ref-address contexts (`ref`/`out`/`in` payloads and `&` operands) as a narrow ergonomic fix for byref call sites. That solved the immediate interop pain but left normal expression code without a concise conditional operator.

This split now creates two problems: users must learn a special-purpose ternary that works only in ref contexts, and parser/binder logic carries a context-sensitive branch instead of a single conditional-expression model. A generalized ternary should preserve ADR-0061 behavior while making `?:` available as a normal expression everywhere an expression is allowed.

Constraints:

- Preserve existing ADR-0061 source compatibility and diagnostics intent.
- Keep `?` in type clauses (`T?`) unambiguous from expression ternary.
- Avoid introducing hidden evaluation or reordering; only one arm may execute.
- Keep byref safety rules from ADR-0058 intact for ref/out/in and `&` usage.

## Decision

Introduce a general conditional expression form:

```gsharp
ConditionalExpression := LogicalOrExpression ['?' Expression ':' ConditionalExpression]
```

It is right-associative (`a ? b : c ? d : e` parses as `a ? b : (c ? d : e)`), has lower precedence than logical-or and higher precedence than assignment, and is valid in any expression position.

### 1. Syntax and parsing

Add `ConditionalExpressionSyntax` (`Condition`, `QuestionToken`, `WhenTrue`, `ColonToken`, `WhenFalse`) and parse it after binary/logical parsing, before assignment binding. The parser no longer needs a ref-only syntax node (`ConditionalRefArgumentExpressionSyntax`) once migration is complete.

`&`/`ref`/`out`/`in` contexts continue to accept ternary payloads naturally because they now consume general expressions. No dedicated parser hook is required for `&cond ? a : b`; it parses as `&(cond ? a : b)` by precedence.

### 2. Value semantics

Binding `cond ? x : y` in value context enforces:

1. `cond` must be `bool` (existing non-bool condition diagnostic path).
2. Only one branch executes at runtime (short-circuit by branch).
3. Result type is chosen by common-type rules:
   - If `Tx == Ty`, result is `Tx`.
   - Else if `Tx -> Ty` implicit and not `Ty -> Tx`, result is `Ty` (convert true arm).
   - Else if `Ty -> Tx` implicit and not `Tx -> Ty`, result is `Tx` (convert false arm).
   - Else if both are implicit numeric conversions, use existing numeric tie-break precedence (ADR-0037) to choose the wider canonical numeric target.
   - Else if one arm is `nil` and the other is nullable/reference-compatible, use the non-`nil` arm type.
   - Else emit a new diagnostic (`GS0263`: no common conditional result type).

Produce a new `BoundConditionalExpression` node for value semantics.

### 3. Ref/address semantics (subsuming ADR-0061)

In ref-kind argument positions and address-of contexts, if the operand is a conditional expression and both arms are valid lvalues of the same pointee type, bind to `BoundConditionalAddressExpression` (existing ADR-0061 node/emit path) instead of `BoundConditionalExpression`.

Rules stay aligned with ADR-0061:

- Both branches must be lvalues.
- Branch pointee types must match exactly (no cross-branch value-conversion for byref).
- `ref`/`out`/`&` require writable branches; `in` may target read-only branches.
- Ref-safe-to-escape is computed per branch; combined scope is the narrower one.
- `out var`/`out let`/`out _` inside a branch remains rejected (existing GS0261 behavior).

Inner branch modifiers (`ref`/`out`/`in` within branches) become unnecessary in the generalized form and are removed from the grammar. The canonical source form is:

```gsharp
f(ref (cond ? a : b))
f(out (cond ? a : b))
f(in  (cond ? a : b))
let p = &(cond ? a : b)
```

For compatibility, legacy branch modifiers may be accepted behind a transitional parser path and normalized away, but they are not part of the long-term grammar.

### 4. Emit/lowering

`BoundConditionalExpression` lowers to branch-based value selection with a join temporary only when needed by surrounding context. `BoundConditionalAddressExpression` keeps existing ADR-0061 emit (`brfalse`/`br` selecting one `T&` on the evaluation stack before call/use).

No runtime helper is required.

### 5. Diagnostics

Keep existing ADR-0061 diagnostics where applicable (notably branch type mismatch for byref and inline declaration in branch). Add:

- **GS0263**: conditional expression branches have no common result type.

Retire/refactor:

- **GS0259** (conditional outside ref context) is removed once generalized ternary is enabled, because the expression is now valid in general contexts.

## Consequences

- **Positive**: one coherent ternary model for both value and byref use; simpler mental model and better ergonomics in everyday expressions.
- **Positive**: ADR-0061 behavior is preserved by binding strategy, not parser special-casing.
- **Positive**: parser architecture becomes cleaner (no ref-only conditional syntax category).
- **Neutral**: introduces one new bound node (`BoundConditionalExpression`) and conversion/type-selection logic similar to existing binary-expression conversion decisions.
- **Negative**: migration requires coordinated parser, binder, diagnostics, and tests to avoid regressions around `?` precedence and byref safety.

## Alternatives considered

1. Keep ADR-0061 ref-only conditional and do not add general ternary. Rejected because it preserves a context-sensitive language irregularity and leaves non-ref code verbose.
2. Reuse `switch` expression only. Rejected because two-arm conditionals are much more common and `switch` is heavier syntactically and semantically.
3. Add ternary only for value expressions and keep separate ref-only syntax. Rejected because two parallel conditional syntaxes increase complexity and divergence.

## Rollout plan

1. Add `ConditionalExpressionSyntax` and parser precedence integration.
2. Add `BoundConditionalExpression` + common-type binding and conversion insertion.
3. Route ref/out/in and `&` contexts to existing `BoundConditionalAddressExpression` when conditional operands are lvalue-compatible.
4. Keep legacy ADR-0061 parser form temporarily; emit a deprecation diagnostic if desired; remove after one release window.
5. Update tests: parser precedence/associativity, value-typed ternaries, ref/out/in/byref ternaries, diagnostics (`GS0263`, retirement of GS0259).

## References

- Issue #495
- ADR-0061
- ADR-0060
- ADR-0058
- ADR-0037
