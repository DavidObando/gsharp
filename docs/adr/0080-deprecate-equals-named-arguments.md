# ADR-0080: Deprecate `name = value` named-argument spelling (warning)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 6 (cleanup)
- **Related**: Issue #343 (call-site named arguments), ADR-0032
  (data-struct ergonomics, introduced `.copy(field = value)` sugar),
  ADR-0047 (attribute syntax and declaration, uses argument-list
  parser for `@Attr(prop = value)`), ADR-0060 (ref/out/in parameters),
  ADR-0063 (overloading and optional parameters), ADR-0071 (`if let` /
  `guard let` `:` bindings), ADR-0074 (switch-arm `:`).
  Parent issue #706, implementing issue #720.

## Context

GSharp has two syntactically distinct spellings for a named argument
at a call site or in an attribute argument list:

```gsharp
Foo(timeout: 30)         // canonical, issue #343
Foo(timeout = 30)        // legacy, kept for back-compat
```

The `=` form predates the call-site named-arguments work (issue #343).
It originated with ADR-0032 (`data struct` `.copy(field = value)` sugar)
and was extended to attribute argument lists (ADR-0047). When issue
#343 generalised named arguments to every call site, the parser kept
the `=` form so existing `.copy(...)` and attribute usages did not
have to be rewritten in the same release.

Today both spellings flow through the same `ParseArgumentsCore`
helper (`src/Core/CodeAnalysis/Syntax/Parser.cs`), produce the same
`NamedArgumentExpressionSyntax`, and bind identically. The binder
does not care which separator was used. Two spellings for the same
construct are nonetheless a long-term parser tax and an FAQ:

- **Cognitive cost.** Users have to learn two shapes and pick one.
  Tooling (formatters, completion, code fixes) has to ship rules for
  both. Documentation has to repeat itself.
- **Grammar pressure.** Argument-list parsing is one of the hottest
  ambiguity surfaces in the language (ref/out/in modifiers, lambda
  argument expressions, conditional ref-arguments, trailing object
  initializers, `:` for `if let`, `:` for switch arms). Every extra
  in-argument token shape narrows the design space for future
  features.
- **Consistency.** Every other call-adjacent named-binding construct
  in modern GSharp already uses `:` — struct/class literal field
  initializers (`Point{x: 1}`), map entries (`{"k": v}`), switch
  arms (`case 0: "zero"` — ADR-0074), and `if let` / `guard let`
  bindings (ADR-0071). The argument-list `=` is the lone holdout.

The `=` form is functionally redundant: any callable that accepts
`Name = value` also accepts `Name: value` today. Migrating in-tree
samples, tests, and docs is mechanical (search-and-replace inside
argument lists, with the usual sweep discipline to avoid touching
real assignments).

## Decision

Emit a **warning** (severity `Warning`, soft diagnostic — code
`GS0315`) at parse time whenever a named argument inside a call
argument list or attribute argument list uses the legacy `=`
separator instead of the canonical `:`. The warning is anchored
at the `=` token and identifies the argument name.

The diagnostic text is:

> Named argument `'<name>'` uses the deprecated `'='` separator;
> use `'<name>: value'` instead (ADR-0080).

The parser continues to accept the `=` form for this release —
the resulting `NamedArgumentExpressionSyntax` binds and emits
exactly as it does today. The warning provides a one-release
grace period before the parser rejects `=` in argument position;
removal is tracked as a separate follow-up issue (Phase 6
sub-task of #706) and a future ADR will flip the diagnostic to
an error and delete the parser branch.

### Scope: both back-compat slots warn

The warning fires uniformly at **every** call-site and
attribute argument list:

1. **General call arguments** — `Foo(timeout = 30)`, including
   user functions, user methods, user constructors, user
   extension functions, imported CLR methods/constructors,
   imported extension methods, and inherited CLR instance
   methods (issue #343).
2. **`.copy(field = value)`** — the ADR-0032 `data struct`
   copy sugar. Same parser path, same diagnostic.
3. **Attribute argument lists** — `@AttributeUsage(All,
   AllowMultiple = true)`, `@DebuggerDisplay("{V}", Target =
   typeof(string))` (ADR-0047). Same parser path, same
   diagnostic.

There is no exemption for `.copy(...)` or attributes. Both
slots accept `field: value` today; the migration is mechanical.

### Out of scope: other `=` shapes

The warning explicitly **does not** fire on:

- Plain assignment expressions (`x = 1`).
- Parameter default values (`func f(x int32 = 0)` — ADR-0063;
  parsed by `ParseParameter`, not `ParseArguments`).
- `with`-expression field initializers (`p with { x = 10 }` —
  parsed by `ParseFieldEqualsInitializers`, a separate path).
- Object/struct/class composite literal field initializers
  (`Point{x: 1}` already uses `:`; the legacy `{X = v}` brace
  form does not exist in GSharp).
- The `=` token inside the value position of an argument
  (`Foo(timeout: x = 1)` is `Foo(timeout: (x = 1))` — the `=`
  is an assignment inside the argument expression, not the
  named-argument separator).

The parser disambiguates by looking exactly one token ahead
of an identifier in argument position: `IDENT :` or `IDENT =`
is a named argument. Any other follower (including a more
complex expression starting with that identifier) parses as
an expression and is not affected by GS0315.

## Severity and grace period

`GS0315` is a **warning** rather than an error to provide a
one-release grace period for existing GSharp code. Suppress
per-project via `<NoWarn>GS0315</NoWarn>` in a `.gsproj` or
`/nowarn:GS0315` on the command line; promote to an error
via `<WarningsAsErrors>` / `/warnaserror+:GS0315` for projects
that want to enforce the policy locally today.

The follow-up issue (escalation to error, parser branch removal)
is filed under parent #706. The expected sequence is:

1. **This release** (ADR-0080, issue #720): warning emitted;
   in-tree samples, tests, and docs migrated to `:` so the
   build stays green with no `GS0315` occurrences. Both
   spellings still parse.
2. **Next release** (follow-up): warning becomes error;
   `ParseArgumentsCore` rejects `=` after an identifier in
   argument position and recovers by synthesising a `:` token
   so downstream binding stays well-formed. Documentation
   marks the `=` form removed.

## Consequences

Positive:

- One canonical named-argument spelling across every call site
  and attribute argument list. Aligns with `:` in struct
  literals, map entries, switch arms (ADR-0074), and
  `if let`/`guard let` bindings (ADR-0071).
- Reclaims an in-argument token shape so future grammar work
  (e.g., trailing-lambda heuristics, more ref-kind composition)
  has fewer cases to disambiguate.
- Documentation, examples, and IDE suggestions converge on a
  single spelling.

Negative:

- Existing GSharp source using `name = value` in argument lists
  emits a warning until migrated. Migration is purely textual
  (replace `=` with `:` inside the argument list). The Oats
  sweep migrates every in-tree sample, test, and doc in the
  same PR that lands this ADR.
- Two declaration shapes co-exist during the grace period.

Neutral:

- No symbol, binder, lowering, or emit change. The
  `NamedArgumentExpressionSyntax` node still records the
  separator token (`EqualsToken`); downstream code paths
  remain identical.
- `with { x = 10 }` and parameter default values
  (`func f(x int32 = 0)`) are not affected — they parse on
  separate paths.

## Open follow-ups

- Follow-up issue under parent #706 escalates `GS0315` to an
  error and removes the `=` branch from `ParseArgumentsCore`.
  Rename `NamedArgumentExpressionSyntax.EqualsToken` to
  `SeparatorToken` (or `ColonToken`) at that time.
- The `NamedArgumentExpressionSyntax` doc-comment currently
  describes the node as `Name = value`; updated by this ADR to
  cite both spellings and the deprecation. When the `=` form is
  removed, simplify back to `Name: value`.
