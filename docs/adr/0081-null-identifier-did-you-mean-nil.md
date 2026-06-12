# ADR-0081: "Did you mean `nil`?" diagnostic for the `null` identifier

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 6 (cleanup)
- **Related**: ADR-0001 (null model — `nil` is the canonical null
  literal), issue #660 (initial GS0273 wiring inside attribute
  arguments), issue #706 (Oats cleanup parent), implementing issue
  #721.

## Context

G# spells the null literal `nil` (ADR-0001). The token `null` is
**not** a keyword: it parses as an ordinary identifier and resolves
through the usual variable / function / type lookup. Users coming
from C#, Kotlin, Java, or TypeScript reflexively type `null` —
historically that produced the generic GS0125 "Variable 'null'
doesn't exist" diagnostic, which gives no hint that the language
expects the spelling `nil`.

Issue #660 introduced a small, targeted special case: when
`ReportUndefinedVariable` was called with the name `null`, it
re-routed to a new **GS0273** "use 'nil' instead of 'null'"
diagnostic so that `@Obsolete(null)` produced an actionable error.
Issue #721 widens the surface and pins the contract:

- The diagnostic must fire in **every** value-expression position
  where the user could plausibly mean nil — not just attribute
  argument lists.
- It must **not** fire when the identifier `null` is bound to a
  real symbol in scope (e.g., a free function `func null() {}` or
  a local `let null = "x"`). Identifiers named `null` in
  declaration-like positions remain legal.
- When the surrounding context has a target type that accepts nil
  (a `NullableTypeSymbol`, a reference type, or a `T?` parameter
  slot), the binder should **recover** by treating the offending
  identifier as if the user had written `nil`. This prevents a
  cascade of cannot-convert / type-mismatch errors from the same
  source mistake.
- The diagnostic wording must point at the fix: "Did you mean
  'nil'?".

## Decision

Keep `null` as a plain identifier — no lexer or parser change. The
binder owns the diagnostic and the recovery.

### Wording and code

GS0273 (severity **Error**) — wording:

> `'null'` is not a literal in G#. Did you mean `'nil'`?

The diagnostic is anchored at the `null` identifier token. It is an
error (not a warning) because the source is unambiguously wrong:
even with the synthesized recovery, the program as written does not
compile under G#'s rules.

### When the diagnostic fires

The binder emits GS0273 whenever **all** of the following hold for
a `NameExpressionSyntax`:

1. The identifier token's text is exactly `"null"`.
2. The token is in a **value-expression position** — i.e., the
   parser produced a `NameExpressionSyntax`, which only happens
   when the syntactic position calls for an expression. Names that
   appear in declaration-like positions (function names, field
   names, type names, parameter names) never reach this binder
   path; they are bound as declared symbols and the binder treats
   them as ordinary identifiers.
3. Symbol lookup in the enclosing `BoundScope` returns no symbol
   with that name (variable, function, type, parameter, alias —
   nothing).

When any one of those fails, GS0273 does not fire. Concretely:

- `func null() { }` declares a function named `null`. A later
  `null()` call resolves through `TryBindMethodGroup`, hits a real
  symbol, and no diagnostic is emitted.
- `let null = "hello"` declares a local named `null`. A later
  `let s = null` resolves the local; no diagnostic.
- `var null int32` (a field named `null` inside a struct) is
  legal; member access through the field works as for any other
  identifier.

### Recovery

When GS0273 fires, the binder also synthesises a `nil` literal
(`BoundLiteralExpression(syntax, value: null)` — static type
`TypeSymbol.Null`) and returns it from `BindNameExpression`
instead of `BoundErrorExpression`. The synthesized node carries
the same syntax span as the offending identifier.

Downstream consumers see the same shape they would have seen had
the user written `nil`:

- In a target-type slot (e.g., the right-hand side of
  `let x string? = null`, an argument to `Foo(null)` where `Foo`
  takes `T?`, or the field initializer of a nullable-typed
  property), the existing `nil → T?` conversion path applies and
  the expression typechecks cleanly. No cascading "cannot convert"
  diagnostic fires.
- In a comparison (`x == null`, `null != y`), the recovered nil
  literal flows into `BoundBinaryOperator.Bind`, which already
  has the lifted-equality arm for `T? == nil`. No cascading
  operator-not-defined error fires.
- Inside a lambda body, the recovery runs through the same
  `BindNameExpression` path; nested binding behaves identically to
  top-level.
- When there is no nullable target type (`let x = null` with no
  type clause), the synthesized nil flows into the usual
  binding-from-nil path — which today binds `x` to the nil
  sentinel type. The user still gets GS0273 as the **first** and
  most actionable diagnostic; whatever follow-on diagnostic the
  binder produces about the inferred nil type stays in place for
  the residual issue.

This single recovery rule subsumes the earlier "fall through to
the generic name-not-found diagnostic" recommendation discussed in
the issue. We chose the recovery path uniformly because the user
clearly intended a null literal — the recovered-as-nil program is
strictly more informative (and often compilable) than the
cascading "name not found" + "type cannot be inferred" pair.

### Why not a soft keyword?

A lexer/parser-level recognition of `null` (e.g., produce a
synthesised `NilKeyword` token with a diagnostic) was considered
and rejected:

- It would steal the identifier `null` from any user who chose to
  name a function, local, field, or parameter `null`. The current
  scheme keeps that name legally usable.
- It would shift the diagnostic out of the binder, away from the
  scope information the rule actually depends on. The binder
  already knows whether `null` resolves to a symbol; the lexer
  does not.
- The binder-level rule is purely additive: no existing well-typed
  G# program changes shape.

The binder-anchored path is therefore the contract going forward.

## Consequences

Positive:

- Newcomers from C#/Kotlin/Java/TypeScript get a clear, actionable
  error message — and a compiling recovery — the first time they
  type `null`.
- The diagnostic is precise: it fires only when the source is
  unambiguously wrong (the identifier `null` is undefined in
  scope), so user code that legitimately names a symbol `null`
  is unaffected.
- No grammar surface change. `null` remains a plain identifier;
  existing programs that already accept the identifier `null`
  (none in tree, but theoretically possible) keep working.
- The recovery removes the cascade of follow-on diagnostics that
  previously made the underlying spelling mistake harder to spot.

Negative:

- Slight behavior change relative to issue #660's initial GS0273:
  the diagnostic message is reworded (the new wording matches the
  issue acceptance criteria), and the binder now returns a nil
  literal recovery rather than `BoundErrorExpression`. The two
  existing Issue660 tests still assert only the diagnostic code
  and the presence of `nil` in the message; both remain satisfied.

Neutral:

- No new BoundNodeKind. The recovery reuses the existing
  `BoundLiteralExpression` node shape used by `nil`.
- No emit, lowering, or rewriter change. The bound tree downstream
  of the recovery is indistinguishable from the user having
  written `nil`.

## Open follow-ups

None. The change is self-contained at the binder boundary; no
parser, emit, or interpreter follow-up is needed.
