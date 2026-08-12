# ADR-0162: full patterns in boolean `is` expressions

- **Status**: Accepted
- **Date**: 2026-08-11
- **Phase**: Language patterns / flow analysis
- **Related**: ADR-0009 (switch patterns), ADR-0069 (smart-cast narrowing), ADR-0071 (`if let` / `guard let` bindings), [#3351](https://github.com/DavidObando/gsharp/issues/3351), parent [#3347](https://github.com/DavidObando/gsharp/issues/3347)

## Context

G# already had constant, type, property, relational, list, parenthesized, and
`and` / `or` / `not` patterns, but only `switch` could reach that grammar.
Expression-level `is` accepted only a `TypeClause`. Wiring the existing pattern
parser into `is` exposed three additional design problems:

1. switch type patterns used the binding spelling `name is Type`, which would
   produce the incoherent boolean form `value is _ is Type`;
2. a bare name can denote either a type or an existing enum/const/value pattern;
3. type and property patterns did not compose, and the right side of `and` bound
   against the original rather than the narrowed input type.

Property patterns also conflict syntactically with a following statement body:
`if value is { P: 1 } { body }`.

## Decision

### Boolean `is`

`Expression is Pattern` and `Expression !is Pattern` accept the full pattern
grammar. The result is `bool`. The expression value is evaluated once and then
matched by the same `PatternBinder` and `MethodBodyEmitter.EmitPattern` pipeline
used by `switch`.

### Bare type patterns: option B

A bare type clause is a type pattern in every pattern position:

```gs
if value is string { ... }
if value is string { Length: > 0 } { ... }

switch value {
    case string: ...
    case string { Length: > 0 }: ...
}
```

Name-shaped patterns retain both syntax interpretations until binding through
`TypeOrConstantPatternSyntax`. Resolution preserves each context's established
meaning:

- `switch` is **value-first**, then type. Existing enum members, constants, and
  value patterns therefore keep their meaning.
- boolean `is` is **type-first**, then value. Existing `value is Type`
  programs therefore keep their meaning.
- a property suffix commits the name to the type interpretation.

When both a value and type have the same name, `== name` forces the value
interpretation in boolean pattern position; the legacy `_ is Type` spelling can
force a type interpretation in a switch if a value shadows it.

This is option B rather than a capitalization heuristic. Symbol resolution and
legacy context determine meaning; enum/const switch patterns do not regress.

### Type + property composition and `and`

A type pattern may carry a property-pattern suffix. Binding resolves the
property members against the tested type, and emission evaluates them from the
successfully narrowed value.

For `P and Q`, if `P` guarantees a type-pattern narrowing, `Q` binds and emits
against that narrowed local. This applies in boolean `is`, switch statements,
and switch expressions.

### Braces in body headers

Inside a body header, `{ ... }` is parsed speculatively as a property pattern.
The parser commits only when the completed pattern has a valid continuation
(for example a following body brace, boolean operator, or closing parenthesis).
A lone `{}` remains the statement body, preserving `if value is Type {}`.
Parentheses are the explicit escape hatch: `if (value is {}) { ... }`.

### Bindings

Boolean pattern position introduces no scope. Source-visible type or slice
bindings are rejected with **GS0525** and direct users to `if let` or
`guard let`. Switch bindings keep their existing rules, including GS0390 under
`or` / `not`.

## Consequences

Positive:

- every existing pattern form is usable as a boolean test;
- type/property shapes and `and` narrowing now work in switch positions too;
- one binder and one emitter own pattern semantics;
- old `value is Type`, enum-member cases, and const cases retain their meaning.

Negative:

- a name-shaped pattern is semantically disambiguated rather than decided by
  parser token shape alone;
- boolean pattern bindings remain unavailable because no sound post-expression
  scope exists.

## Alternatives considered

- **Option A: bare types only after expression-level `is`** — sound and smaller,
  but leaves switch syntax inconsistent and does not enable `case Type { ... }`.
  Rejected because compatibility-aware semantic resolution makes option B
  deterministic without changing existing switch value patterns.
- **Capitalization heuristic** — rejected; G# type and value naming is not a
  semantic contract, and imported symbols need not follow one convention.
- **Require `_ is Type` in boolean position** — rejected as redundant and hard
  to read.
- **Allow bindings in boolean `is`** — rejected because an expression has no
  coherent region in which the name is definitely assigned. `if let` and
  `guard let` already provide explicit binding scopes.
